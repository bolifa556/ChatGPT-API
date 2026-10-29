"""Run a CI check and include its failure details in GitHub annotations."""
import subprocess
import sys


def main():
    result = subprocess.run(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    output = result.stdout.decode('utf-8', errors='replace')
    print(output, end='', flush=True)
    if result.returncode:
        detail = output[-12000:].replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
        print('::error title=Verification failed::' + detail, flush=True)
    return result.returncode


if __name__ == '__main__':
    sys.exit(main())
