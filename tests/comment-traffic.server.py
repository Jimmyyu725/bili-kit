from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlsplit
import gzip,json,os
from pathlib import Path
os.chdir(Path(__file__).resolve().parents[1])
class Handler(SimpleHTTPRequestHandler):
 def do_GET(self):
  path=urlsplit(self.path).path
  if not path.startswith('/meter/'):
   return super().do_GET()
  data={'code':0,'data':[{'rpid':n,'text':'评论流量测试中文🙂'*20} for n in range(30)]}
  status=503 if path=='/meter/fail' else 200
  if status==503:data={'code':-1,'message':'test failure'}
  encoded=gzip.compress(json.dumps(data,ensure_ascii=False,separators=(',',':')).encode())
  self.send_response(status)
  self.send_header('Content-Type','application/json; charset=utf-8')
  self.send_header('Content-Encoding','gzip')
  self.send_header('Content-Length',str(len(encoded)))
  self.send_header('Cache-Control','public, max-age=3600' if path=='/meter/cache' else 'no-store')
  self.send_header('Access-Control-Allow-Origin','*')
  self.end_headers();self.wfile.write(encoded)
ThreadingHTTPServer(('127.0.0.1',8771),Handler).serve_forever()
