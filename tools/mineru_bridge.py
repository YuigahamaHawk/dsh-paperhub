"""Small public-SDK adapter. The reader supplies only its stored PDF and an output path."""
import argparse,json,pathlib,time,importlib.metadata,os,sys


def available_commit_bytes():
    """Windows commit headroom includes the page file and any process limit."""
    if sys.platform != 'win32':
        return None
    from ctypes import Structure, WinDLL, POINTER, byref, c_uint64, sizeof
    from ctypes.wintypes import BOOL, DWORD

    class MemoryStatus(Structure):
        _fields_ = [
            ('length', DWORD), ('memory_load', DWORD),
            ('total_physical', c_uint64), ('available_physical', c_uint64),
            ('total_page_file', c_uint64), ('available_page_file', c_uint64),
            ('total_virtual', c_uint64), ('available_virtual', c_uint64),
            ('available_extended_virtual', c_uint64),
        ]

    status = MemoryStatus()
    status.length = sizeof(status)
    query = WinDLL('kernel32').GlobalMemoryStatusEx
    query.argtypes = [POINTER(MemoryStatus)]
    query.restype = BOOL
    return status.available_page_file if query(byref(status)) else None

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--status',action='store_true')
    parser.add_argument('--input')
    parser.add_argument('--output')
    parser.add_argument('--tier',choices=['basic','standard'],default='standard')
    parser.add_argument('--page-range',default='')
    args=parser.parse_args()
    version=importlib.metadata.version('mineru')
    if not version.startswith('4.'):
        raise RuntimeError('Reader requires MinerU 4.x middle JSON')
    if not args.status:
        available = available_commit_bytes()
        # Keep a small reserve before importing the model runtime.
        if available is not None and available < 512 * 1024**2:
            print(json.dumps({'error': 'parser-commit-low', 'availableMiB': available // 1024**2}), flush=True)
            return 1
    # Reading never starts a weight download or uses a configured remote VLM endpoint.
    os.environ['MINERU_MODEL_SOURCE']='local'
    os.environ['MINERU_MODEL_VLM_SERVER_URL']=''
    os.environ['MINERU_TELEMETRY_DISABLED']='1'
    from mineru.model.registry import model_repos_for_tier
    from mineru.model.download import verify_model_repo
    missing=[repo.name for repo in model_repos_for_tier(args.tier) if not verify_model_repo(repo).ready]
    if missing:
        raise RuntimeError('MinerU local models missing: '+', '.join(missing)+'. Install models explicitly before parsing.')
    if args.status:
        print(json.dumps({'version':version,'local':True}),flush=True)
        return
    from mineru import parse
    started=time.monotonic()
    print(json.dumps({'stage':'parsing','version':version,'tier':args.tier}),flush=True)
    result=parse(args.input,tier=args.tier,image_analysis=False,page_range=args.page_range)
    output=pathlib.Path(args.output)
    value={'middle':result.to_dict(),'elapsedMs':round((time.monotonic()-started)*1000),'version':version,'tier':args.tier,'local':True}
    temporary=output.with_name(output.name+'.part')
    temporary.write_text(json.dumps(value,ensure_ascii=False),encoding='utf8')
    temporary.replace(output)
    print(json.dumps({'stage':'complete','elapsedMs':value['elapsedMs'],'pages':len(result.pages)}),flush=True)

if __name__=='__main__':
    raise SystemExit(main())
