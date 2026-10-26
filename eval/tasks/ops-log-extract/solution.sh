cd "$SANDBOX" && python3 -c "
import json,collections
R=[]
for l in open('access.log'):
    try: R.append(json.loads(l))
    except ValueError: pass
json.dump({'total_requests':len(R),'errors_5xx':sum(500<=r['status']<600 for r in R),'top_paths':[p for p,_ in collections.Counter(r['path'] for r in R).most_common(3)],'slowest_request_id':max(R,key=lambda r:r['ms'])['id'],'unique_ips':len({r['ip'] for r in R})},open('report.json','w'))"
