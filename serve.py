import os, sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
port = int(os.environ.get('PORT', 3456))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
HTTPServer(('', port), SimpleHTTPRequestHandler).serve_forever()
