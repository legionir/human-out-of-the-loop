import subprocess
r=subprocess.run(['rg','-o','HOTL_[A-Z_]+','src','--type','ts','-g','!**/__tests__/**','--no-filename'],capture_output=True,text=True)
keys=sorted(set(l.strip() for l in r.stdout.splitlines() if l.strip()))
open('audit/tmp/keys.txt','w').write('\n'.join(keys)+'\n')
print(len(keys),'keys')
