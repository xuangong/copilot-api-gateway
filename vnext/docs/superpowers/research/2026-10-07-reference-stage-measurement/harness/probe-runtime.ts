import { AsyncLocalStorage } from "node:async_hooks"
export interface Trace {id:string;marks:{name:string;at:number}[];counts:Record<string,number>;overflow:boolean}
export function createProbe(now:()=>number, limit=128) {
  const context = new AsyncLocalStorage<Trace>()
  const traces = new Map<string, Trace>()
  let unowned = 0
  return {
    run<T>(id:string, action:()=>T):T {
      if (traces.has(id)) throw new Error("duplicate probe ownership")
      if (traces.size >= 1024) throw new Error("probe request capacity exceeded")
      const trace: Trace = {id,marks:[],counts:Object.create(null) as Record<string,number>,overflow:false}
      traces.set(id,trace)
      return context.run(trace,action)
    },
    emit(kind:string,name:string,value=1):void {
      const trace = context.getStore()
      if (!trace) {unowned++;return}
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(name) || !Number.isFinite(value) || value < 0) {trace.overflow=true;return}
      if (kind === "mark") {
        if (trace.marks.length >= limit) {trace.overflow=true;return}
        trace.marks.push({name,at:now()})
      } else if (kind === "count") {
        if (!Object.hasOwn(trace.counts,name) && Object.keys(trace.counts).length >= 64) {trace.overflow=true;return}
        const total = (trace.counts[name] ?? 0) + value
        if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total)) {trace.overflow=true;return}
        trace.counts[name]=total
      } else trace.overflow=true
    },
    snapshot():Trace[]{return [...traces.values()].map(trace=>({...trace,marks:trace.marks.map(mark=>({...mark})),counts:{...trace.counts}}))},
    unowned(){return unowned},
  }
}
