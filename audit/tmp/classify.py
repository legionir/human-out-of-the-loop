import re, os
rows=[]
with open('audit/tmp/all_files.txt') as f:
    for i,p in enumerate(f.read().splitlines(),1):
        lines=0
        try: lines=sum(1 for _ in open(p,errors='ignore'))
        except: pass
        # type/lang/module
        ext=p.rsplit('.',1)[1] if '.' in os.path.basename(p) else ''
        if p.startswith('servers-main/'): lang='py' if p.endswith('.py') else ('ts' if p.endswith('.ts') else 'other'); mod='vendored-mcp-servers'
        elif p.startswith('src/ai/'): lang='ts'; mod='ai-runtime'
        elif p.startswith('src/cli/'): lang='ts'; mod='cli'
        elif p.startswith('src/server'): lang='ts'; mod='web-server'
        elif p.startswith('src/mcp/'): lang='ts'; mod='mcp-server-expose'
        elif p.startswith('src/'): lang='ts'; mod='root-src'
        elif p.startswith('e2e/'): lang='mjs'; mod='e2e'
        elif p.startswith('public/'): lang='js/css/html'; mod='web-frontend'
        elif p.startswith('registry/'): lang='json'; mod='registry-data'
        elif p.startswith('docs/'): lang='md'; mod='docs'
        elif p.startswith('.github/'): lang='yml'; mod='ci'
        else: lang={ 'json':'json','md':'md','yml':'yml','ts':'ts','mjs':'mjs','sh':'sh' }.get(ext,ext or 'other'); mod='root'
        # tier
        gen='no'
        if p.startswith('servers-main/'): tier='T4'; gen='vendored(upstream mcp servers)'
        elif p.endswith('package-lock.json') or p.endswith('uv.lock'): tier='T4'; gen='generated(package-manager)'
        elif '/__tests__/' in p or p.endswith('.test.ts'): tier='T3'
        elif p.startswith('docs/') or p.endswith('.md'): tier='T3'
        elif p.startswith('registry/'): tier='T3'
        elif p.startswith('public/'): tier='T2'
        elif p.startswith('e2e/'): tier='T3'
        elif p.startswith('.github/'): tier='T3'
        elif p.endswith('.ts') or p.endswith('.mjs'): tier='T1'
        else: tier='T3'
        # test flag
        test='yes' if ('__tests__' in p or p.endswith('.test.ts') or p.startswith('e2e/')) else 'no'
        role=''
        if tier=='T1' and p.startswith('src/'): role='runtime-source'
        rows.append(f"FILE-{i:05d}\t{p}\t{lines}\t{ext or 'none'}\t{lang}\t{mod}\t{tier}\t{gen}\t{test}\t{role}\t{tier}")
hdr="id\tpath\tlines\ttype\tlang\tmodule\ttier\tgenerated\ttest\trole\tdepth_required"
open('audit/manifest/files.tsv','w').write(hdr+'\n'+'\n'.join(rows)+'\n')
print('rows:',len(rows))
