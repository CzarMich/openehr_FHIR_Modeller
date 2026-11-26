#!/usr/bin/env python3
"""Run the same independent tests against a local DLL or a hosted-built image."""
import argparse,os,shutil,socket,subprocess,tempfile,time,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--image');p.add_argument('--sdk-image');p.add_argument('--dll',type=Path);args=p.parse_args()
assert sum(bool(v) for v in (args.image,args.sdk_image,args.dll))==1,'Choose one executable source'
with tempfile.TemporaryDirectory(prefix='modeller-dotnet-contracts-') as temp:
    fixture=Path(temp);shutil.copytree(ROOT/'resources/guides',fixture/'guides')
    (fixture/'outside-secret.txt').write_text('synthetic-private-canary')
    (fixture/'guides/howto/linked-secret.md').symlink_to('../../outside-secret.txt')
    key=os.urandom(32).hex();(fixture/'key').write_text(key);(fixture/'key').chmod(0o400)
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    env=dict(os.environ,AUTH_API_KEY=key,AUTH_API_KEY_HEADER='X-API-Key',GUIDE_ROOT=str(fixture/'guides'),DOTNET_MCP_API_KEY_FILE=str(fixture/'key'),ASPNETCORE_URLS=f'http://127.0.0.1:{port}',DOTNET_ENVIRONMENT='Production')
    if args.image or args.sdk_image:
        command=['docker','run','--rm','-i','--network','host','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=32m','--cap-drop=ALL','--security-opt=no-new-privileges','--user',f'{os.getuid()}:{os.getgid()}','-v',f'{fixture}:/fixtures:ro','-e','GUIDE_ROOT=/fixtures/guides','-e','DOTNET_MCP_API_KEY_FILE=/fixtures/key','-e',f'ASPNETCORE_URLS=http://127.0.0.1:{port}']
        if args.sdk_image:command += ['-v',f'{ROOT}:/repo:ro','--entrypoint','dotnet',args.sdk_image,'/repo/dotnet/Modeller.Mcp/bin/Release/net10.0/Modeller.Mcp.dll']
        else:command += [args.image]
    else:command=['dotnet',str(args.dll.resolve())]
    with (fixture/'server.log').open('w') as log:
        process=subprocess.Popen(command,env=env,stdin=subprocess.PIPE,stdout=log,stderr=log)
        try:
            for attempt in range(100):
                if process.poll() is not None:raise AssertionError((fixture/'server.log').read_text())
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/ready',timeout=1) as response:
                        if response.status==200:break
                except Exception:time.sleep(.1)
            else:raise AssertionError('HTTP startup timed out')
            subprocess.run(['python3',str(ROOT/'dotnet/tests/contract-smoke.py'),'--url',f'http://127.0.0.1:{port}/mcp'],env=env,check=True,timeout=180)
        finally:
            process.terminate()
            try:process.wait(timeout=15)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=15)
    # --stdio exits before HTTP credential/configuration is loaded.
    subprocess.run(['python3',str(ROOT/'dotnet/tests/contract-smoke.py'),'--stdio',*command,'--stdio'],env=env,check=True,timeout=180)
