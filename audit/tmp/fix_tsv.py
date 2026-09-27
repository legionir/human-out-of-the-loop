import os
rows=[]
with open('audit/manifest/files_base.tsv') as f:
    hdr=f.readline().rstrip('\n').split('\t')
    for line in f:
        i,p,l=line.rstrip('\n').split('\t')
        ext=p.rsplit('.',1)[1] if '.' in os.path.basename(p) else ''
        if p.startswith('servers-main/'): lang='py' if p.endswith('.py') else ('ts' if p.endswith('.ts') else 'other'); mod='vendored-mcp-servers'
        elif p.startswith('src/ai/'): lang='ts'; mod='ai-runtime'
        elif p.startswith('src/cli/'): lang='ts'; mod='cli'
        elif p.startswith('src/server'): lang='ts'; mod='web-server'
        elif p.startswith('src/mcp/'): lang='ts'; mod='mcp-server-expose'
        elif p.startswith('src/'): lang='ts'; mod='root-src'
        elif p.startswith('e2e/'): lang='mjs'; mod='e2e'
        elif p.startswith('public/'): lang='frontend'; mod='web-frontend'
        elif p.startswith('registry/'): lang='json/md'; mod='registry-data'
        elif p.startswith('docs/'): lang='md'; mod='docs'
        elif p.startswith('.github/'): lang='yml'; mod='ci'
        else: lang={'json':'json','md':'md','yml':'yml','ts':'ts','mjs':'mjs','sh':'sh'}.get(ext,ext or 'other'); mod='root'
        gen='no'; tier='T3'
        if p.startswith('servers-main/'): tier='T4'; gen='vendored(upstream modelcontextprotocol/servers)'
        elif p.endswith('package-lock.json') or p.endswith('uv.lock'): tier='T4'; gen='generated(package-manager)'
        elif '/__tests__/' in p or p.endswith('.test.ts') or p.startswith('e2e/'): tier='T3'
        elif p.startswith('docs/') or p.endswith('.md') or p.startswith('registry/') or p.startswith('.github/'): tier='T3'
        elif p in ('vitest.config.ts','tsconfig.json','package.json','.gitignore','scripts/ci-test.mjs'): tier='T3'
        elif p.startswith('public/'): tier='T2'
        elif p.endswith('.ts') or p.endswith('.mjs'): tier='T1'
        test='yes' if ('__tests__' in p or p.endswith('.test.ts') or p.startswith('e2e/')) else 'no'
        role='runtime-source' if tier in('T1','T2') else ''
        depth='L2+L3' if tier=='T1' else ('L2' if tier=='T2' else ('L1' if tier=='T3' else 'L0'))
        rows.append('\t'.join([i,p,l,ext or 'none',lang,mod,tier,gen,test,role,depth,'','' ,'TODO','','']))
hdr='id\tpath\tlines\ttype\tlang\tmodule\ttier\tgenerated\ttest\trole\tdepth_required\tdepth_done\tranges_read\tstatus\tworkflows\tnotes'
open('audit/manifest/files.tsv','w').write(hdr+'\n'+'\n'.join(rows)+'\n')
# dirs.tsv
dirs=sorted(set(os.path.dirname(p) for p in open('audit/tmp/all_files.txt').read().split()))
out=['id\tpath\tpurpose\tstatus']
for n,d in enumerate(dirs,1):
    out.append(f"DIR-{n:04d}\t{d or '.'}\t\tTODO")
open('audit/manifest/dirs.tsv','w').write('\n'.join(out)+'\n')
print('files:',len(rows),'dirs:',len(dirs))
