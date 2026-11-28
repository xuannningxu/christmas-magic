const origin = 'https://xuannningxu.github.io';
const page = origin + '/christmas-magic/';
const headers = {'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store'};
const json = (body,status=200) => Response.json(body,{status,headers});

async function paypal(env,path,options={}) {
  const base = env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const auth = await fetch(base+'/v1/oauth2/token',{
    method:'POST',
    headers:{Authorization:'Basic '+btoa(env.PAYPAL_CLIENT_ID+':'+env.PAYPAL_CLIENT_SECRET),'Content-Type':'application/x-www-form-urlencoded'},
    body:'grant_type=client_credentials'
  });
  if (!auth.ok) throw new Error('PayPal authorization failed');
  const {access_token} = await auth.json();
  const response = await fetch(base+path,{
    ...options,
    headers:{Authorization:'Bearer '+access_token,'Content-Type':'application/json',...options.headers}
  });
  if (!response.ok) throw new Error('PayPal request failed');
  return response.json();
}

function verifiedCapture(order,row,merchant) {
  const units = order.purchase_units;
  if (order.id !== row.order_id || order.status !== 'COMPLETED' || units?.length !== 1) return null;
  const unit = units[0];
  const captures = unit.payments?.captures;
  if (unit.custom_id !== row.id || unit.payee?.merchant_id !== merchant || captures?.length !== 1) return null;
  const capture = captures[0];
  return capture.status === 'COMPLETED' && capture.final_capture === true &&
    capture.amount?.currency_code === 'USD' && capture.amount?.value === '0.50' && capture.id ? capture.id : null;
}
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
}

export default {
  async fetch(request,env) {
    if (request.headers.get('Origin') !== origin) return json({error:'Forbidden'},403);
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers});
    if (request.method !== 'POST') return json({error:'Method not allowed'},405);
    const path = new URL(request.url).pathname;
    if (!['/create','/confirm'].includes(path)) return json({error:'Not found'},404);
    if (![env.PAYPAL_CLIENT_ID,env.PAYPAL_CLIENT_SECRET,env.PAYPAL_MERCHANT_ID,env.PAYMENTS].every(Boolean)) {
      return json({error:'Payments unavailable'},503);
    }
    try {
      if (path === '/create') {
        const id = crypto.randomUUID();
        const secret = crypto.randomUUID()+crypto.randomUUID();
        const order = await paypal(env,'/v2/checkout/orders',{
          method:'POST',headers:{'PayPal-Request-Id':id},
          body:JSON.stringify({intent:'CAPTURE',purchase_units:[{
            custom_id:id, description:'Christmas Magic · Personalized HTML export',
            amount:{currency_code:'USD',value:'0.50'},payee:{merchant_id:env.PAYPAL_MERCHANT_ID}
          }],payment_source:{paypal:{experience_context:{
            user_action:'PAY_NOW',shipping_preference:'NO_SHIPPING',
            return_url:page+'?checkout=return',cancel_url:page+'?checkout=cancel'
          }}}})
        });
        const approval = order.links?.find(link=>['payer-action','approve'].includes(link.rel));
        const approvalUrl = approval && new URL(approval.href);
        if (!approvalUrl || approvalUrl.protocol !== 'https:' ||
          !['www.paypal.com','www.sandbox.paypal.com'].includes(approvalUrl.hostname)) throw new Error('Invalid approval URL');
        await env.PAYMENTS.prepare('INSERT INTO export_orders (id, order_id, proof) VALUES (?,?,?)')
          .bind(id,order.id,await digest(secret)).run();
        return json({id,secret,approval:approvalUrl.href});
      }
      const {id,secret,orderId} = await request.json();
      if (![id,secret,orderId].every(x=>typeof x === 'string' && x.length > 0 && x.length <= 100)) return json({error:'Invalid order'},400);
      const row = await env.PAYMENTS.prepare('SELECT * FROM export_orders WHERE id=? AND proof=? AND order_id=?')
        .bind(id,await digest(secret),orderId).first();
      if (!row) return json({error:'Order not found'},404);
      if (row.exported) return json({error:'Export already claimed'},409);
      const orderPath = '/v2/checkout/orders/'+encodeURIComponent(row.order_id);
      let order = await paypal(env,orderPath);
      if (order.status === 'APPROVED') {
        try {
          await paypal(env,orderPath+'/capture',{method:'POST',headers:{'PayPal-Request-Id':'capture-'+row.id},body:'{}'});
        } catch {
          // A previous capture may have succeeded even if its response was lost.
        }
        order = await paypal(env,orderPath);
      }
      const capture = verifiedCapture(order,row,env.PAYPAL_MERCHANT_ID);
      if (!capture) return json({error:'Payment not verified'},409);
      const claim = await env.PAYMENTS.prepare('UPDATE export_orders SET capture_id=?, exported=1 WHERE id=? AND exported=0')
        .bind(capture,row.id).run();
      if (claim.meta.changes !== 1) return json({error:'Export already claimed'},409);
      return json({paid:true});
    } catch {
      return json({error:'Payment could not be verified'},502);
    }
  }
};
