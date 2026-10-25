import type { Express } from 'express';

/** Long-lived HTTP/SSE calls defer replacement until their normal completion. */
export function trackHttpRuntimeWork(app:Express):()=>boolean {
  let activeRequests=0;
  app.use((_req,res,next)=>{
    activeRequests++;
    let finished=false;
    const complete=()=>{
      if(!finished) {finished=true;activeRequests--;}
    };
    res.once('finish',complete);
    res.once('close',complete);
    next();
  });
  return ()=>activeRequests===0;
}
