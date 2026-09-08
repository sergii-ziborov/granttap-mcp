import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const CONNECTION_WIDGET_URI = "ui://granttap/connection/v1.html";

const html = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
:root{color-scheme:light dark;font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;padding:16px;background:transparent;color:CanvasText}
.card{border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:20px;padding:18px;background:color-mix(in srgb,Canvas 94%,#ff7a3d 6%);box-shadow:0 8px 28px #0001}
header{display:flex;align-items:center;gap:12px;margin-bottom:14px}.logo{width:44px;height:44px;border-radius:13px;background:#ff7a3d;display:grid;place-items:center;color:#19120e;font-weight:800;font-size:19px}.title{font-size:19px;font-weight:750}.status{display:flex;align-items:center;gap:7px;color:color-mix(in srgb,CanvasText 72%,transparent)}
.dot{width:9px;height:9px;border-radius:50%;background:#ffb020}.connected .dot{background:#2ac769}.error .dot{background:#e5484d}
.body{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center}.copy{max-width:440px}.copy h2{font-size:18px;margin:0 0 6px}.copy p{margin:0;color:color-mix(in srgb,CanvasText 70%,transparent)}
#qr{width:170px;height:170px;padding:10px;background:#fff;border-radius:15px;object-fit:contain}.hidden{display:none!important}
.actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:16px}button{font:inherit;font-weight:650;border-radius:11px;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);padding:9px 13px;background:Canvas;color:CanvasText;cursor:pointer}button.primary{background:#ff7a3d;color:#17100c;border-color:#ff7a3d}button:disabled{opacity:.55;cursor:wait}
.confirm{margin-top:12px;padding:12px;border-radius:12px;background:color-mix(in srgb,#e5484d 10%,transparent)}.confirm p{margin:0 0 10px}.small{font-size:13px}.message{min-height:20px;margin-top:10px;color:color-mix(in srgb,CanvasText 68%,transparent)}
@media(max-width:520px){.body{grid-template-columns:1fr}#qr{width:min(100%,220px);height:auto;justify-self:center}}
</style>
</head>
<body>
<main class="card" id="card">
  <header><div class="logo" aria-hidden="true">✓▥</div><div><div class="title">GrantTap</div><div class="status"><span class="dot"></span><span id="status">Checking connection…</span></div></div></header>
  <section class="body">
    <div class="copy"><h2 id="heading">Connect this computer</h2><p id="detail">Open GrantTap on iPhone and scan the one-time code.</p><div class="actions"><button class="primary" id="connect">Connect</button><button id="copy">Copy pairing link</button><button id="reconnect">Reconnect</button></div><div class="message small" id="message" role="status"></div></div>
    <img id="qr" class="hidden" alt="GrantTap pairing QR" />
  </section>
  <section id="confirm" class="confirm hidden"><p>Reconnect replaces this computer’s current pairing. Continue?</p><div class="actions"><button class="primary" id="confirm-reconnect">Reconnect</button><button id="cancel">Cancel</button></div></section>
</main>
<script type="module">
const $=id=>document.getElementById(id);let pairingUri="";let seq=0;const waiting=new Map();
function metadata(value){if(!value||typeof value!=="object")return{};if(value.granttap)return value;if(value._meta)return value._meta;if(value.mcp_tool_result?._meta)return value.mcp_tool_result._meta;if(value.call_tool_result?._meta)return value.call_tool_result._meta;return{}}
function output(value){return value?.structuredContent??value?.structured_content??value?.mcp_tool_result?.structuredContent??value?.call_tool_result?.structuredContent??{}}
function apply(value){const state=output(value);const meta={...metadata(window.openai?.toolResponseMetadata),...metadata(value)};const gt=meta.granttap??{};if(gt.pairingUri)pairingUri=gt.pairingUri;if(gt.qrDataUrl){$("qr").src=gt.qrDataUrl;$("qr").classList.remove("hidden")}const status=state.status??"disconnected";$("card").className="card "+status;$("status").textContent=status==="connected"?"Connected":status==="pairing"?"Waiting for iPhone":"Ready to connect";$("heading").textContent=status==="connected"?"This computer is connected":"Connect this computer";$("detail").textContent=status==="connected"?("Secure pairing active"+(state.relay?(" through "+state.relay):"")+"."):"Open GrantTap on iPhone and scan the one-time code.";$("connect").classList.toggle("hidden",status!=="disconnected");$("copy").classList.toggle("hidden",!pairingUri);$("reconnect").classList.toggle("hidden",status==="disconnected");if(status==="connected")$("qr").classList.add("hidden")}
function initial(){const response={structuredContent:window.openai?.toolOutput??{},_meta:window.openai?.toolResponseMetadata??{}};apply(response)}
async function call(name,args={}){setBusy(true);$("message").textContent="Working…";try{let result;if(window.openai?.callTool)result=await window.openai.callTool(name,args);else result=await rpc(name,args);apply(result);$("message").textContent=result?.isError?(result.content?.[0]?.text??"GrantTap could not complete the request."):"Ready.";return result}catch(error){$("card").classList.add("error");$("message").textContent=String(error)}finally{setBusy(false)}}
function rpc(name,args){const id="granttap-"+Date.now()+"-"+(++seq);window.parent.postMessage({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:args}},"*");return new Promise((resolve,reject)=>waiting.set(id,{resolve,reject}))}
function setBusy(value){document.querySelectorAll("button").forEach(button=>button.disabled=value)}
window.addEventListener("message",event=>{const data=event.data;if(data?.method==="ui/notifications/tool-result")apply(data.params);const pending=waiting.get(data?.id);if(!pending)return;waiting.delete(data.id);if(data.error)pending.reject(new Error(data.error.message??"Tool call failed"));else pending.resolve(data.result)});
$("connect").addEventListener("click",()=>call("connect"));$("reconnect").addEventListener("click",()=>$("confirm").classList.remove("hidden"));$("cancel").addEventListener("click",()=>$("confirm").classList.add("hidden"));$("confirm-reconnect").addEventListener("click",async()=>{$("confirm").classList.add("hidden");await call("reconnect",{confirmed:true})});$("copy").addEventListener("click",async()=>{try{await navigator.clipboard.writeText(pairingUri);$("message").textContent="Pairing link copied."}catch{$("message").textContent="Copy is unavailable. Scan the QR instead."}});initial();
</script>
</body>
</html>`;

export function registerConnectionWidget(server: McpServer): void {
  server.registerResource(
    "granttap-connection",
    CONNECTION_WIDGET_URI,
    {
      title: "GrantTap connection center",
      description: "Interactive GrantTap pairing status, QR, connect, and reconnect controls.",
      mimeType: "text/html;profile=mcp-app",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/html;profile=mcp-app",
        text: html,
        _meta: {
          ui: { prefersBorder: true },
          "openai/widgetDescription": "Connect or reconnect this computer to GrantTap with a one-time QR.",
          "openai/widgetPrefersBorder": true,
        },
      }],
    }),
  );
}
