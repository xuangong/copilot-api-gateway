from pathlib import Path
import subprocess,json,re,statistics,sys
root=Path(sys.argv[1]).resolve()
w=Path(__file__).resolve().parent
rows=[]
for size in [1,10,50]:
 for mode in ["old","incremental"]:
  for repeat in range(1,4):
   p=subprocess.run(["/usr/bin/time","-l","bun",str(w/"task-B05-hash-benchmark.mjs"),mode,str(size)],cwd=root,capture_output=True,text=True,check=True)
   data=json.loads(p.stdout.strip())
   data["osPeakRssBytes"]=int(re.search(r"(\d+)\s+maximum resident set size",p.stderr).group(1))
   data["repeat"]=repeat
   rows.append(data)
for size in [1,10,50]:
 selected=[r for r in rows if r["mib"]==size]
 assert len({r["id"] for r in selected})==1
 if size>1:
  assert all(r["timerCallbacksBeforeHashComplete"]>0 for r in selected if r["mode"]=="incremental")
summary=[]
for size in [1,10,50]:
 for mode in ["old","incremental"]:
  selected=[r for r in rows if r["mib"]==size and r["mode"]==mode]
  summary.append({"mib":size,"mode":mode,**{key:{"median":statistics.median(r[key] for r in selected),"range":[min(r[key] for r in selected),max(r[key] for r in selected)]} for key in ["osPeakRssBytes","hashDurationMs","timerDelayMs","maxSchedulerGapMs"]}})
result={"head":subprocess.check_output(["git","rev-parse","HEAD"],cwd=root,text=True).strip(),"runtime":subprocess.check_output(["bun","--version"],cwd=root,text=True).strip(),"rows":rows,"summary":summary}
(w/"task-B05-hash-root-benchmark-results.json").write_text(json.dumps(result,indent=2)+"\n")
print(json.dumps(summary,indent=2))
