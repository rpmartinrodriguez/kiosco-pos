import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
const methods=['Efectivo','Mercado Pago'];
const adminEmail=()=> (process.env.ADMIN_EMAIL||'admin@kiosco.com').trim().toLowerCase();
const hash=s=>createHash('sha256').update(s).digest('hex');
const money=n=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',minimumFractionDigits:Number.isInteger(n)?0:2,maximumFractionDigits:2}).format(n);
const fail=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const num=(n,{min=0,integer=false}={})=>{if(typeof n!=='number'||!Number.isFinite(n)||n<min||Math.abs(n)>1e12||(integer&&!Number.isSafeInteger(n)))fail('Importe o cantidad inválida');return n};
const str=(s,max=200,required=true)=>{if(typeof s!=='string'||s.length>max||(required&&!s.trim()))fail('Texto inválido');return s.trim()};
const id=s=>{if(typeof s!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(s))fail('Identificador inválido');return s};
const reply=(statusCode,data)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(data)});
function init(){if(!getApps().length){if(!process.env.FIREBASE_SERVICE_ACCOUNT_JSON)fail('Falta configurar Firebase Admin en Netlify',503);const key=JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);if(key.project_id!=='kiosco-app-15942')fail('Proyecto Firebase incorrecto',503);initializeApp({credential:cert(key),projectId:key.project_id})}return getFirestore()}
async function identity(db,headers){const token=(headers.authorization||headers.Authorization||'').match(/^Bearer (.+)$/)?.[1];if(!token)fail('Sesión requerida',401);let u;try{u=await getAuth().verifyIdToken(token,true)}catch{fail('Sesión inválida',401)}const email=(u.email||'').toLowerCase();const p=(await db.collection('users').doc(u.uid).get()).data();const role=email===adminEmail()?'admin':p?.active===true&&['manager','cashier','admin'].includes(p.role)?(p.role==='admin'?'admin':'cashier'):null;if(!role)fail('Usuario no autorizado',403);return {uid:u.uid,email,name:p?.name||u.name||email,role,mustChangePassword:p?.mustChangePassword===true,resetPending:p?.resetPending===true,authTime:u.auth_time}}
const categoryKey=s=>s.trim().replace(/\s+/g,' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
async function canonicalCategory(db,tx,value){
 const label=str(value||'',100,false).replace(/\s+/g,' '),key=categoryKey(label);
 if(!key)return '';
 const ref=db.collection('categories').doc(hash(key)),snap=await tx.get(ref);
 if(snap.exists)return snap.data().name;
 // Reuse an existing spelling from products created before categories were indexed.
 const products=await tx.get(db.collection('products'));
 const matches=products.docs.map(x=>x.data().category).filter(x=>typeof x==='string'&&categoryKey(x)===key).sort((x,y)=>x.localeCompare(y,'es'));
 const name=matches[0]?.trim().replace(/\s+/g,' ')||label.charAt(0).toLocaleUpperCase('es-AR')+label.slice(1);
 return {name,ref,key};
}
const actor=u=>({uid:u.uid,email:u.email,name:u.name});
const privileged=u=>{if(!['admin','cashier'].includes(u.role))fail('No tenés permiso para esta operación',403)};
async function state(db,u){
 const isAdmin=u.role==='admin',lock=await db.doc('meta/cash').get(),active=lock.data()?.active||null;
 const rows=x=>x?x.docs.map(d=>({id:d.id,...d.data()})):[];
 const [p,s,v,m,c,a,profiles]=await Promise.all([
 db.collection('products').get(),
 isAdmin?db.collection('sessions').get():active?db.collection('sessions').doc(active).get():Promise.resolve(null),
 isAdmin?db.collection('sales').get():active?db.collection('sales').where('sessionId','==',active).get():Promise.resolve(null),
 isAdmin?db.collection('stockMoves').get():db.collection('stockMoves').orderBy('at','desc').limit(200).get(),
 isAdmin?db.collection('cashMoves').get():active?db.collection('cashMoves').where('sessionId','==',active).get():Promise.resolve(null),
 isAdmin?db.collection('audit').orderBy('at','desc').limit(100).get():Promise.resolve(null),
 isAdmin?db.collection('users').get():Promise.resolve(null)
 ]);
 const group=x=>{const g=Object.create(null);for(const r of rows(x))(g[r.sessionId]??=[]).push(r);return g};
 const vs=group(v),cs=group(c),sessions=isAdmin?rows(s):s?.exists?[{id:s.id,...s.data()}]:[];
 const users=isAdmin?rows(profiles).map(x=>({uid:x.id,name:x.name||x.email||x.id,email:x.email||'',role:x.role==='admin'?'admin':'cashier',active:x.active===true,mustChangePassword:x.mustChangePassword===true})):[];
 if(isAdmin&&!users.some(x=>x.email.toLowerCase()===adminEmail()))users.unshift({uid:u.email===adminEmail()?u.uid:'',name:u.email===adminEmail()?u.name:'Administrador principal',email:adminEmail(),role:'admin',active:true});
 return {products:rows(p),sessions:sessions.sort((a,b)=>a.at-b.at).map(x=>({...x,sales:(vs[x.id]||[]).map(v=>isAdmin?v:{...v,items:v.items.map(({cost,...i})=>i)}).sort((a,b)=>a.at-b.at),moves:(cs[x.id]||[]).sort((a,b)=>a.at-b.at)})),moves:rows(m).sort((a,b)=>a.at-b.at),active,audit:rows(a),user:u,users};
}
function purchaseInput(p,{signed=false,optionalCost=false}={}){
 if(!p||!['unit','pack'].includes(p.mode))fail('Presentación inválida');
 const size=num(p.unitsPerPack,{min:1,integer:true});if(p.mode==='unit'&&size!==1)fail('Presentación unitaria inválida');
 const count=num(p.count,{min:signed?-1e12:0,integer:true}),units=num(count*size,{min:signed?-1e12:0,integer:true});
 const cost=optionalCost&&p.cost===undefined?null:num(p.cost),vatMode=p.vatMode===undefined?'included':p.vatMode;
 if(!['included','excluded'].includes(vatMode))fail('Condición de IVA inválida');
 if(cost!==null&&signed&&count<=0)fail('Solo se puede actualizar el costo en ingresos de stock');
 const grossCost=cost===null?null:vatMode==='excluded'?Math.round((cost*1.21+Number.EPSILON)*100)/100:cost;
 if(grossCost!==null)num(grossCost);
 return {mode:p.mode,unitsPerPack:size,count,units,cost,vatMode,vatRate:vatMode==='excluded'?21:0,grossCost,unitCost:grossCost===null?null:grossCost/size};
}
async function createUser(db,u,d,requestId){
 if(u.role!=='admin')fail('Solo administración',403);
 const ref=db.collection('audit').doc(id(requestId)),old=await ref.get();
 if(old.exists){const prev=old.data();if(prev.action!=='createUser'||prev.actor.uid!==u.uid)fail('Solicitud duplicada',409);return {ok:true,uid:prev.details.uid,duplicate:true}}
 const name=str(d.name,100),email=str(d.email,254).toLowerCase(),password=d.password,role=d.role;
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email===adminEmail())fail('Correo no válido o reservado');
 if(typeof password!=='string'||password.length<8||password.length>128)fail('La contraseña debe tener entre 8 y 128 caracteres');
 if(!['cashier','admin'].includes(role))fail('Perfil inválido');
 let user;try{user=await getAuth().createUser({email,password,displayName:name,disabled:false})}catch(e){if(e.code==='auth/email-already-exists')fail('Ya existe un usuario con ese correo',409);if(e.code==='auth/invalid-password'||e.code==='auth/invalid-email')fail('Correo o contraseña inválidos');throw e}
 const profile=db.collection('users').doc(user.uid),now=Date.now(),batch=db.batch();
 batch.create(profile,{name,email,role,active:true,createdAt:now,createdBy:actor(u),mustChangePassword:true,temporaryPasswordHash:passwordHash(password),resetPending:false});
 batch.create(ref,{id:ref.id,at:now,action:'createUser',actor:actor(u),notify:false,title:'Usuario creado',body:name+' · '+email+' · '+(role==='admin'?'Administrador':'Cobrador'),details:{uid:user.uid,email,name,role}});
 try{await batch.commit()}catch(e){try{const committed=await ref.get();if(committed.exists&&committed.data().details?.uid===user.uid)return {ok:true,uid:user.uid};const exists=await profile.get();if(!exists.exists)await getAuth().deleteUser(user.uid)}catch(cleanup){console.error('createUser rollback',cleanup.code||cleanup.message)}throw e}
 return {ok:true,uid:user.uid};
}
const passwordHash=password=>{const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,32).toString('hex')};
function samePassword(password,hashValue){if(typeof hashValue!=='string')return false;const [salt,hex]=hashValue.split(':');if(!salt||!hex||hex.length!==64)return false;return timingSafeEqual(Buffer.from(hex,'hex'),scryptSync(password,salt,32))}
function validPassword(password){if(typeof password!=='string'||password.length<8||password.length>128)fail('La contraseña debe tener entre 8 y 128 caracteres');return password}
async function resetPassword(db,u,d,requestId){
 if(u.role!=='admin')fail('Solo administración',403);
 const password=validPassword(d.password),email=str(d.email,254).toLowerCase();
 let target;try{target=await getAuth().getUserByEmail(email)}catch(e){if(e.code==='auth/user-not-found')fail('Usuario inexistente',404);throw e}
 const ref=db.collection('users').doc(target.uid),profile=(await ref.get()).data(),primary=email===adminEmail();
 if(!primary&&profile?.active!==true)fail('Usuario no autorizado',403);
 if(target.disabled)fail('Usuario deshabilitado',403);
 const audit=db.collection('audit').doc(id(requestId)),previous=await audit.get();if(previous.exists){if(previous.data().action!=='resetPassword'||previous.data().actor.uid!==u.uid)fail('Solicitud duplicada',409);return {ok:true,self:target.uid===u.uid}}
 const resetId=audit.id;
 const hashValue=passwordHash(password);await db.runTransaction(async tx=>{const current=(await tx.get(ref)).data();if(current?.resetPending&&Date.now()-(current.resetPendingAt||0)<60000)fail('Hay un cambio de contraseña en curso. Reintentá en un minuto',409);tx.set(ref,{name:profile?.name||target.displayName||email,email,role:primary?'admin':profile.role,active:true,mustChangePassword:true,resetPending:true,resetPendingAt:Date.now(),resetId,temporaryPasswordHash:hashValue},{merge:true})});
 await getAuth().updateUser(target.uid,{password});
 await getAuth().revokeRefreshTokens(target.uid);
 const tokens=await db.collection('pushTokens').where('uid','==',target.uid).get();await Promise.all(tokens.docs.map(x=>x.ref.delete()));
 await db.runTransaction(async tx=>{const current=(await tx.get(ref)).data();if(current?.resetId!==resetId)fail('Hay otro restablecimiento en curso',409);tx.update(ref,{resetPending:false,resetPendingAt:null});tx.create(audit,{id:audit.id,at:Date.now(),action:'resetPassword',actor:actor(u),notify:false,title:'Contraseña temporal asignada',body:email,details:{uid:target.uid,email}})});
 return {ok:true,self:target.uid===u.uid};
}
async function changePassword(db,u,d){
 if(!u.mustChangePassword||u.resetPending)fail('No hay una contraseña temporal habilitada',403);
 const password=validPassword(d.password),ref=db.collection('users').doc(u.uid),profile=(await ref.get()).data();
 if(!profile?.mustChangePassword||profile.resetPending)fail('La contraseña temporal cambió; iniciá sesión nuevamente',409);
 if(typeof d.temporary!=='string'||d.temporary.length>128||!samePassword(d.temporary,profile.temporaryPasswordHash))fail('La contraseña temporaria actual es incorrecta',403);
 if(samePassword(password,profile.temporaryPasswordHash))fail('La nueva contraseña tiene que ser distinta de la temporal');
 const marker=randomBytes(16).toString('hex');await db.runTransaction(async tx=>{const fresh=(await tx.get(ref)).data();if(fresh?.temporaryPasswordHash!==profile.temporaryPasswordHash||fresh?.resetPending)fail('La contraseña temporal cambió; iniciá sesión nuevamente',409);tx.update(ref,{resetPending:true,resetPendingAt:Date.now(),resetId:marker})});
 await getAuth().updateUser(u.uid,{password});
 await getAuth().revokeRefreshTokens(u.uid);
 await db.runTransaction(async tx=>{const fresh=(await tx.get(ref)).data();if(fresh?.temporaryPasswordHash!==profile.temporaryPasswordHash||fresh?.resetId!==marker)fail('Otro administrador restableció la contraseña; volvé a iniciar sesión',409);tx.update(ref,{mustChangePassword:false,temporaryPasswordHash:null,resetPending:false,resetPendingAt:null});tx.create(db.collection('audit').doc(),{at:Date.now(),action:'changePassword',actor:actor(u),notify:false,title:'Contraseña personal actualizada',body:u.email,details:{uid:u.uid}})});
 return {ok:true};
}
async function productHistory(db,u,d){
 privileged(u);const productId=id(d.id);const product=(await db.collection('products').doc(productId).get()).data();if(!product)fail('Producto inexistente',404);
 // Historical versions before 2.2 used details.after.id or details.productId.
 const [direct,legacy,adjust,moves]=await Promise.all([
 db.collection('audit').where('productId','==',productId).get(),
 db.collection('audit').where('details.after.id','==',productId).get(),
 db.collection('audit').where('details.productId','==',productId).get(),
 db.collection('stockMoves').where('productId','==',productId).get()
 ]);
 const unique=new Map();for(const snap of [direct,legacy,adjust])for(const doc of snap.docs){const x=doc.data();if(['product','adjust'].includes(x.action))unique.set(doc.id,{id:doc.id,at:x.at,action:x.action,title:x.title,body:x.body,actor:x.actor,details:x.details})}
 return {product,events:[...unique.values()].sort((a,b)=>b.at-a.at),moves:moves.docs.map(x=>({id:x.id,...x.data()})).filter(x=>x.reason==='Venta').sort((a,b)=>b.at-a.at)};
}
async function push(db,event){const tokens=await db.collection('pushTokens').where('active','==',true).get();const docs=tokens.docs;if(!docs.length)return {sent:0,failed:0,status:'sin dispositivos'};let sent=0,failed=0;for(let i=0;i<docs.length;i+=500){const chunk=docs.slice(i,i+500);const result=await getMessaging().sendEachForMulticast({tokens:chunk.map(d=>d.data().token),notification:{title:event.title,body:event.body.slice(0,350)},webpush:{notification:{icon:'/icon-192.png',tag:event.id},fcmOptions:{link:process.env.URL||'https://'+process.env.SITE_NAME+'.netlify.app'}}});sent+=result.successCount;failed+=result.failureCount;await Promise.allSettled(result.responses.map((r,j)=>['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(r.error?.code)?chunk[j].ref.delete():Promise.resolve()))}return {sent,failed,status:failed?'parcial':'enviado a FCM'}}
async function notificationInbox(db,u){
 if(u.role!=='admin')fail('Solo administración',403);
 const [recent,legacy,receipt]=await Promise.all([db.collection('notifications').orderBy('at','desc').limit(100).get(),db.collection('audit').orderBy('at','desc').limit(100).get(),db.collection('notificationReceipts').doc(u.uid).get()]);
 const map=new Map();
 for(const doc of legacy.docs){const x=doc.data();if(x.notify===true)map.set(doc.id,{id:doc.id,at:x.at,title:x.title,body:x.body,actor:x.actor,delivery:x.delivery||null})}
 for(const doc of recent.docs){const x=doc.data(),prior=map.get(doc.id);map.set(doc.id,{id:doc.id,at:x.at,title:x.title,body:x.body,actor:x.actor,delivery:x.delivery||prior?.delivery||null})}
 const state=receipt.data()||{},items=state.items||{},readBefore=state.readBefore||0,deletedBefore=state.deletedBefore||0;
 const notifications=[...map.values()].sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id)).slice(0,100).filter(x=>x.at>deletedBefore&&items[x.id]?.status!=='deleted').map(x=>({...x,read:x.at<=readBefore||items[x.id]?.status==='read'}));
 return {notifications,unread:notifications.filter(x=>!x.read).length};
}
async function notificationAction(db,u,d){
 if(u.role!=='admin')fail('Solo administración',403);
 if(!['read','delete','readAll','deleteAll'].includes(d.mode))fail('Acción inválida');
 const ref=db.collection('notificationReceipts').doc(u.uid),all=d.mode.endsWith('All'),eventId=all?null:id(d.id),eventRef=eventId?db.collection('notifications').doc(eventId):null;
 await db.runTransaction(async tx=>{
 const snap=await tx.get(ref),prev=snap.data()||{},items={...(prev.items||{})};let readBefore=prev.readBefore||0,deletedBefore=prev.deletedBefore||0;
 if(all){const now=Date.now();if(d.mode==='deleteAll'){deletedBefore=Math.max(now,deletedBefore);readBefore=Math.max(now,readBefore)}else readBefore=Math.max(now,readBefore);
 for(const [k,v] of Object.entries(items))if(v.at<=deletedBefore||(v.status==='read'&&v.at<=readBefore))delete items[k];
 }else{const eventSnap=await tx.get(eventRef),legacy=eventSnap.exists?null:await tx.get(db.collection('audit').doc(eventId)),ev=eventSnap.data()||legacy?.data();if(!ev||(!eventSnap.exists&&ev.notify!==true))fail('Notificación inexistente',404);
 if(ev.at>deletedBefore&&items[eventId]?.status!=='deleted')items[eventId]={at:ev.at,status:d.mode==='delete'?'deleted':'read'};
 }
 // Keep a bounded receipt document. Only events older than the most recent 500 individual marks are compacted.
 const entries=Object.entries(items).sort((a,b)=>b[1].at-a[1].at);for(const [k] of entries.slice(500))delete items[k];
 tx.set(ref,{items,readBefore,deletedBefore,updatedAt:Date.now()});
 });
 return {ok:true};
}
async function dispatch(db,ev){if(!ev?.notify)return null;let result;try{result=await push(db,ev)}catch(e){console.error('FCM',e.code||e.message);result={status:'error de envío',sent:0,failed:0}}try{const batch=db.batch();batch.update(db.collection('audit').doc(ev.id),{delivery:result});batch.set(db.collection('notifications').doc(ev.id),{delivery:result},{merge:true});await batch.commit()}catch(e){console.error('audit delivery',e.message)}return result}
async function mutate(db,u,action,d,requestId){const now=Date.now(),who=actor(u),eventRef=db.collection('audit').doc(id(requestId)),lockRef=db.doc('meta/cash');return db.runTransaction(async tx=>{const old=await tx.get(eventRef);if(old.exists){if(old.data().actor.uid!==u.uid||old.data().action!==action)fail('Solicitud duplicada',409);return {event:old.data(),duplicate:true}}let event={id:eventRef.id,at:now,actor:who,action,notify:true,title:'Kiosco POS',body:'',details:{}};const record=(title,body,details={},notify=true)=>Object.assign(event,{title,body:`${body} · ${u.name}`,details,notify});const productRef=x=>db.collection('products').doc(id(x));const sessRef=x=>db.collection('sessions').doc(id(x));const stock=(p,delta,reason)=>tx.create(db.collection('stockMoves').doc(),{at:now,productId:p.id,name:p.name,delta,reason,actor:who});
if(action==='product'){privileged(u);const p=d.product||{};const ref=productRef(p.id);const snap=await tx.get(ref);const prev=snap.data();const code=str(p.code||'',80,false);const codeRef=code?db.collection('barcodes').doc(hash(code)):null;const codeSnap=codeRef?await tx.get(codeRef):null;if(codeSnap?.exists&&codeSnap.data().productId!==ref.id)fail('Código de barras duplicado',409);if(Boolean(d.edit)!==snap.exists)fail('El producto cambió, actualizá la pantalla',409);if(prev&&prev.updatedAt!==d.version)fail('El producto fue modificado por otro usuario',409);const purchase=d.purchase?purchaseInput(d.purchase):null;if(purchase&&prev&&purchase.count!==0)fail('El stock de un producto existente se modifica desde movimientos');const category=await canonicalCategory(db,tx,p.category);const next={id:ref.id,code,name:str(p.name),category:typeof category==='string'?category:category.name,cost:purchase?purchase.unitCost:num(p.cost),margin:num(p.margin),price:num(p.price,{min:1,integer:true}),qty:prev?prev.qty:purchase?purchase.units:num(p.qty,{integer:true}),min:num(p.min,{integer:true}),packSize:purchase?purchase.unitsPerPack:prev?.packSize||1,...(purchase?{purchasePricing:{vatMode:purchase.vatMode,inputCost:purchase.cost,unitsPerPack:purchase.unitsPerPack,grossCost:purchase.grossCost}}:{}),updatedAt:now,updatedBy:who};if(typeof category==='object')tx.set(category.ref,{name:category.name,key:category.key,createdAt:now,createdBy:who});if(prev?.code&&prev.code!==code)tx.delete(db.collection('barcodes').doc(hash(prev.code)));if(codeRef)tx.set(codeRef,{productId:ref.id});tx.set(ref,next);event.productId=ref.id;if(!prev&&next.qty)stock(next,next.qty,purchase?.mode==='pack'?'Stock inicial: '+purchase.count+' packs de '+purchase.unitsPerPack:'Stock inicial');const changed=prev&&['price','cost','margin'].some(k=>prev[k]!==next[k]);record(!prev?'Nuevo producto y stock':changed?'Cambio de precio':'Producto modificado',!prev?`${next.name} · ${next.qty} u. · ${money(next.price)}`:changed?`${next.name} · ${money(prev.price)} → ${money(next.price)} · costo ${money(prev.cost)} → ${money(next.cost)}`:next.name,{before:prev||null,after:next,...(purchase?{purchase}:{})});
}else if(action==='adjust'){
 privileged(u);const ref=productRef(d.id),snap=await tx.get(ref);if(!snap.exists)fail('Producto inexistente',404);
 const p=snap.data();event.productId=ref.id;if(d.version!==undefined&&d.version!==p.updatedAt)fail('El producto cambió desde que abriste la reposición. Actualizá y volvé a intentar',409);const purchase=d.purchase?purchaseInput(d.purchase,{signed:true,optionalCost:true}):null,delta=purchase?purchase.units:num(d.delta,{min:-1e12,integer:true}),reason=str(d.reason);
 if(!delta||p.qty+delta<0)fail('Stock insuficiente o cantidad inválida');num(p.qty+delta,{integer:true});
 const patch={qty:p.qty+delta,updatedAt:now,updatedBy:who};
 if(purchase?.mode==='pack')patch.packSize=purchase.unitsPerPack;
 if(purchase&&purchase.cost!==null){patch.cost=purchase.unitCost;patch.purchasePricing={vatMode:purchase.vatMode,inputCost:purchase.cost,unitsPerPack:purchase.unitsPerPack,grossCost:purchase.grossCost};patch.price=d.price===undefined?Math.round(patch.cost*(1+p.margin/100)/100)*100:num(d.price,{min:1,integer:true});if(!Number.isSafeInteger(patch.price)||patch.price<1||patch.price>1e12)fail('El precio sugerido no es válido. Ajustá el costo o el recargo antes de ingresar stock')}
 tx.update(ref,patch);
 const detailReason=reason+(purchase?.mode==='pack'?' · '+purchase.count+' packs de '+purchase.unitsPerPack:'');
 stock(p,delta,detailReason);
 const costChanged=patch.cost!==undefined&&(patch.cost!==p.cost||patch.price!==p.price);
 record(costChanged?'Ingreso de stock y cambio de precio':delta>0?'Ingreso de stock':'Modificación de stock',p.name+': '+p.qty+' → '+(p.qty+delta)+' u. · '+detailReason+(costChanged?' · costo '+money(p.cost)+' → '+money(patch.cost)+' · precio '+money(p.price)+' → '+money(patch.price):''),{productId:p.id,before:p.qty,after:p.qty+delta,delta,reason:detailReason,...(purchase?{purchase}:{}),...(costChanged?{costBefore:p.cost,costAfter:patch.cost,priceBefore:p.price,priceAfter:patch.price}:{})});
}else if(action==='open'){const lock=await tx.get(lockRef);if(lock.data()?.active)fail('Ya hay una caja abierta',409);const ref=db.collection('sessions').doc();const open=num(d.open,{integer:true});tx.create(ref,{id:ref.id,operator:u.name,openedBy:who,at:now,open,expected:open,revenue:0,closed:null});tx.set(lockRef,{active:ref.id});record('Apertura de caja',`Fondo inicial ${money(open)}`,{sessionId:ref.id,open});
}else if(['sale','close','cashMove'].includes(action)){const lock=await tx.get(lockRef),active=lock.data()?.active;if(!active||active!==d.sessionId)fail('La caja ya no está abierta',409);const ref=sessRef(active),snap=await tx.get(ref),s=snap.data();if(!s||s.closed)fail('Caja cerrada',409);if(action==='sale'){if(!Array.isArray(d.items)||!d.items.length||d.items.length>100)fail('Venta inválida');const ids=d.items.map(i=>id(i.id));if(new Set(ids).size!==ids.length)fail('Productos repetidos');const refs=ids.map(productRef),snaps=await tx.getAll(...refs);const items=snaps.map((x,i)=>{const p=x.data(),q=num(d.items[i].qty,{min:1,integer:true});if(!p||p.qty<q)fail('Stock insuficiente',409);if(p.price!==d.items[i].price)fail('Cambió el precio de un producto. Volvé a cargar la venta',409);return {id:p.id,name:p.name,qty:q,price:p.price,cost:p.cost}});const total=items.reduce((a,i)=>a+i.price*i.qty,0);if(!Array.isArray(d.payments)||d.payments.length>methods.length)fail('Pagos inválidos');const payments=d.payments.map(p=>{if(!methods.includes(p.method))fail('Medio de pago inválido');return {method:p.method,amount:num(p.amount,{integer:true})}}).filter(p=>p.amount>0);if(new Set(payments.map(p=>p.method)).size!==payments.length||payments.reduce((a,p)=>a+p.amount,0)!==total)fail('El total de los pagos no coincide');const saleRef=db.collection('sales').doc();tx.create(saleRef,{id:saleRef.id,at:now,sessionId:active,items,total,payments,actor:who});for(let i=0;i<items.length;i++){const p=snaps[i].data();tx.update(refs[i],{qty:p.qty-items[i].qty,updatedAt:now,updatedBy:who});stock(p,-items[i].qty,'Venta')}const cash=payments.find(p=>p.method==='Efectivo')?.amount||0;tx.update(ref,{expected:s.expected+cash,revenue:s.revenue+total});const digital=payments.filter(p=>p.method==='Mercado Pago');record(digital.length?'Venta por Mercado Pago':'Venta',`${digital.map(p=>p.method+' '+money(p.amount)).join(' + ')||money(total)} · total ${money(total)}`,{sessionId:active,saleId:saleRef.id,items,total,payments},digital.length>0);
}else if(action==='cashMove'){if(u.role!=='admin')fail('Solo administración',403);const amount=num(d.amount,{min:-1e12,integer:true}),reason=str(d.reason);if(!amount||s.expected+amount<0)fail('Movimiento inválido');tx.create(db.collection('cashMoves').doc(),{sessionId:active,at:now,amount,reason,actor:who});tx.update(ref,{expected:s.expected+amount});record('Movimiento de caja',`${money(amount)} · ${reason}`,{sessionId:active,amount,reason});
}else{const counted=num(d.counted,{integer:true}),notes=str(d.notes||'',500,false);tx.update(ref,{closed:now,counted,closer:u.name,closedBy:who,notes});tx.set(lockRef,{active:null});record('Cierre de caja',`Ventas ${money(s.revenue)} · diferencia ${money(counted-s.expected)}`,{sessionId:active,counted,expected:s.expected,revenue:s.revenue,difference:counted-s.expected})}
}else fail('Acción desconocida');tx.create(eventRef,event);if(event.notify)tx.create(db.collection('notifications').doc(event.id),{id:event.id,at:event.at,title:event.title,body:event.body,actor:event.actor});return {event,duplicate:false}})}
export const handler=async req=>{try{if(!['GET','POST'].includes(req.httpMethod))return reply(405,{error:'Método inválido'});const db=init(),u=await identity(db,req.headers||{});if(req.httpMethod==='GET')return reply(200,u.mustChangePassword?{user:u,mustChangePassword:true,resetPending:u.resetPending}:await state(db,u));const {action,data={},requestId}=JSON.parse(req.body||'{}');if(u.mustChangePassword){if(action==='changePassword'&&!u.resetPending)return reply(200,await changePassword(db,u,data));fail('Debés cambiar la contraseña temporal antes de operar',403)}if(action==='resetPassword')return reply(200,await resetPassword(db,u,data,requestId));if(action==='notificationInbox')return reply(200,await notificationInbox(db,u));if(action==='notificationAction')return reply(200,await notificationAction(db,u,data));if(action==='productHistory')return reply(200,await productHistory(db,u,data));if(action==='createUser')return reply(200,await createUser(db,u,data,requestId));if(['subscribe','unsubscribe','test'].includes(action)){if(u.role!=='admin')fail('Solo administración',403);if(action==='test'){const r=await push(db,{id:requestId||String(Date.now()),title:'Kiosco POS · Prueba',body:'Notificaciones activadas por '+u.name});return reply(200,{delivery:r})}const token=str(data.token,4096);const ref=db.collection('pushTokens').doc(hash(token));if(action==='subscribe')await ref.set({token,uid:u.uid,active:true,updatedAt:Date.now()});else await ref.delete();return reply(200,{ok:true})}const r=await mutate(db,u,action,data,requestId);const delivery=r.duplicate?r.event.delivery||null:await dispatch(db,r.event);return reply(200,{ok:true,delivery})}catch(e){if(!e.status)console.error(e);return reply(e.status||500,{error:e.status?e.message:'Error del servidor. Revisá la configuración o volvé a intentar.'})}};
