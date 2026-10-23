#!/usr/bin/env python3
"""Test native mouse, clipboard, and login controls in Kitty and Neovim."""
import contextlib
import hashlib
import http.server
import json
import os
import shutil
import signal
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

from real import RealEditor, EVIDENCE, RESULTS
from interactive import run_tests
from desktop import Desktop

DESKTOP = {}

class Browser:
    """Run a real browser against a local test authorization page."""
    def __init__(self, root, display, remote=False):
        self.root, self.display, self.attempts = root, display, []
        self.remote, self.blocked_callbacks = remote, []
        self.opener = None
        self.closed = False
        self.executable = os.environ.get('HARNESS_TEST_FIREFOX') or shutil.which('firefox')
        assert self.executable, 'Browser login tests require Firefox; HARNESS_TEST_FIREFOX can select it'
        DESKTOP['firefox_version'] = subprocess.check_output([self.executable,'--version'],text=True).strip()
        DESKTOP['firefox_executable'] = self.executable
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_CONNECT(self): self.send_error(403)
            def do_POST(self):
                if self.path != '/open': self.send_error(403); return
                request = json.loads(self.rfile.read(min(int(self.headers.get('Content-Length',0)),16384)))
                body = json.dumps(owner.open(request)).encode()
                self.send_response(200); self.send_header('Content-Type','application/json')
                self.end_headers(); self.wfile.write(body)
            def do_GET(self):
                if owner.remote and self.path.startswith('http://127.0.0.1:1455/auth/callback?'):
                    owner.blocked_callbacks.append(self.path)
                    self.close_connection = True
                elif self.path.startswith('/authorize/') or self.path.startswith(owner.address+'/authorize/'):
                    number = int(self.path.rsplit('/',1)[1])
                    body = (f'<!doctype html><title>Harness test account {number}</title>'
                            '<style>body{font:24px sans-serif;max-width:800px;margin:80px auto}'
                            'button{font:inherit;padding:16px 30px}</style><h1>Connect the test account</h1>'
                            '<p>This local page uses a synthetic account. No real sign-in is sent.</p>'
                            '<p>Keep the login window open in Neovim. Continue when ready.</p>'
                            f'<form action="/approve/{number}"><button accesskey="c">Continue to Neovim (Alt+Shift+C)</button></form>').encode()
                    self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(body)
                elif self.path.startswith('/approve/') or self.path.startswith(owner.address+'/approve/'):
                    number = int(self.path.rsplit('/',1)[1].split('?')[0])
                    attempt = owner.attempts[number-1]
                    attempt['approved_at'] = time.monotonic()
                    self.send_response(302); self.send_header('Location',attempt['callback']); self.end_headers()
                else: self.send_error(403)
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.address = 'http://127.0.0.1:'+str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.desktop = Desktop(display)

    def open(self, request):
        url, pid = request['url'], request['pid']
        parsed = urllib.parse.urlsplit(url)
        assert parsed.scheme=='https' and parsed.hostname=='auth.openai.com' and len(url)<8192
        query = urllib.parse.parse_qs(parsed.query)
        assert query['redirect_uri']==['http://127.0.0.1:1455/auth/callback']
        assert isinstance(pid,int) and pid>1
        process = Path('/proc')/str(pid)
        assert str(self.root/'bin/harness-test-browser').encode() in (process/'cmdline').read_bytes().split(b'\0')
        fields = (process/'stat').read_text().rsplit(')',1)[1].split()
        parent = (Path('/proc')/fields[1]/'cmdline').read_bytes().split(b'\0')
        assert b'/usr/bin/xdg-open' in parent, 'The registered handler must be selected by the actual system xdg-open'
        callback = query['redirect_uri'][0]+'?'+urllib.parse.urlencode({'code':'test-code','state':query['state'][0],'client_id':'test-issued-client'})
        number = len(self.attempts)+1
        profile = self.root/('firefox-profile-'+str(number)); profile.mkdir()
        prefs = {'network.proxy.type':1,'network.proxy.http':'127.0.0.1','network.proxy.http_port':self.server.server_port,
                 'network.proxy.ssl':'127.0.0.1','network.proxy.ssl_port':self.server.server_port,
                 'network.proxy.no_proxies_on':'' if self.remote else 'localhost,127.0.0.1','network.trr.mode':5,
                 'network.proxy.allow_hijacking_localhost':self.remote,
                 'network.dns.disablePrefetch':True,'network.prefetch-next':False,
                 'browser.shell.checkDefaultBrowser':False,'browser.aboutwelcome.enabled':False,
                 'browser.startup.firstrunSkipsHomepage':True,'termsofuse.bypassNotification':True,
                 'datareporting.policy.dataSubmissionEnabled':False}
        (profile/'user.js').write_text(''.join('user_pref('+json.dumps(key)+','+json.dumps(value)+');\n' for key,value in prefs.items()))
        self.attempts.append({'callback':callback,'opened_at':time.monotonic(),'pid':pid,
                              'starttime':fields[19],'environment':request['environment'],'url':url})
        return [self.executable,'--no-remote','--new-instance','--profile',str(profile),self.address+'/authorize/'+str(number)]

    def title(self, window):
        return self.desktop.title(window)

    def find(self, title):
        return self.desktop.find(title)

    def focus(self, window):
        self.desktop.focus(window)

    def approve(self, window):
        self.key(window, ord('c'), modifiers=(0xffe9, 0xffe1))

    def key(self, window, symbol, modifiers=()):
        self.desktop.key(window, symbol, modifiers)

    def screenshot(self, name):
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','x11grab','-video_size','1280x960',
                        '-i',self.display,'-frames:v','1','-y',str(self.root/(name+'.png'))],check=True)

    def close(self):
        if self.closed: return
        self.closed = True
        def alive(attempt):
            try:
                fields = Path('/proc',str(attempt['pid']),'stat').read_text().rsplit(')',1)[1].split()
                return fields[0]!='Z' and fields[19]==attempt['starttime']
            except ProcessLookupError: return False
            except FileNotFoundError: return False
        for name, timeout in ((signal.SIGTERM,10),(signal.SIGKILL,5)):
            for attempt in self.attempts:
                if alive(attempt):
                    try: os.kill(attempt['pid'],name)
                    except ProcessLookupError: pass
            deadline = time.monotonic()+timeout
            while any(alive(attempt) for attempt in self.attempts) and time.monotonic()<deadline: time.sleep(.05)
        assert not any(alive(attempt) for attempt in self.attempts), 'The test must stop its own Firefox processes'
        if self.opener:
            try: self.opener.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.opener.kill(); self.opener.wait(timeout=5)
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=5)
        self.desktop.close()


@contextlib.contextmanager
def desktop():
    executable = os.environ.get('HARNESS_TEST_XVFB') or shutil.which('Xvfb')
    assert executable and shutil.which('kitty'), 'Login GUI tests require Kitty and Xvfb; HARNESS_TEST_XVFB can select Xvfb'
    read_fd, write_fd = os.pipe()
    with (EVIDENCE/'xvfb.log').open('wb') as log:
        process = subprocess.Popen([executable, '-displayfd', str(write_fd), '-screen', '0', '1280x960x24', '-nolisten', 'tcp'],
                                   pass_fds=(write_fd,), stdout=log, stderr=log)
        os.close(write_fd)
        try:
            with os.fdopen(read_fd) as selected:
                display = ':' + selected.readline().strip()
            assert display != ':' and process.poll() is None, 'Xvfb did not start'
            with Desktop(display) as connection:
                DESKTOP['xvfb_vendor_release'] = connection.vendor_release()
            yield display
        finally:
            process.terminate()
            process.wait(timeout=10)


class GuiEditor(RealEditor):
    instances = []

    def __init__(self, name, display, pending=0, clipboard=True, browser=False, generation=None, hyperlinks=True, ssh=False):
        self.display, self.pending = display, pending
        self.use_browser, self.browser = browser, None
        self.clipboard_enabled, self.finished = clipboard, False
        self.video = None
        self.hyperlinks = hyperlinks
        self.ssh = ssh
        self.steps = []
        self.instances.append(self)
        super().__init__(name, active=False, oauth_mock=True, generation=generation)
        self.observe('true')

    def prepare_browser(self):
        directory = self.root/'bin'
        directory.mkdir(exist_ok=True)
        opener = directory/'xdg-open'
        if self.use_browser and self.browser is None: self.browser = Browser(self.root,self.display,self.ssh)
        capture = '#!/usr/bin/env python3\nimport json,os,sys,urllib.request\nwith open(os.environ["HARNESS_GUI_BROWSER_LOG"],"a") as output: output.write(json.dumps(sys.argv[1:])+"\\n")\n'
        if self.browser:
            opener.unlink(missing_ok=True)
            handler = directory/'harness-test-browser'
            handler.write_text(capture+
                'request={"url":sys.argv[1],"pid":os.getpid(),"environment":{name:os.environ.get(name) for name in ("DISPLAY","WAYLAND_DISPLAY","XAUTHORITY","XDG_CONFIG_HOME","XDG_DATA_HOME","NVIM")}}\n'+
                f'with urllib.request.urlopen({self.browser.address+"/open"!r},data=json.dumps(request).encode(),timeout=10) as response: arguments=json.load(response)\n'+
                'os.execv(arguments[0],arguments)\n')
            handler.chmod(0o700)
            config, data = self.root/'desktop-config', self.root/'desktop-data'
            applications = data/'applications'
            config.mkdir(exist_ok=True); applications.mkdir(parents=True,exist_ok=True)
            (applications/'harness-test-browser.desktop').write_text('[Desktop Entry]\nType=Application\nName=Harness test browser\nExec='+str(handler)+' %u\nMimeType=x-scheme-handler/http;x-scheme-handler/https;\n')
            (config/'mimeapps.list').write_text('[Default Applications]\nx-scheme-handler/http=harness-test-browser.desktop\nx-scheme-handler/https=harness-test-browser.desktop\n')
            self.env.update(XDG_CONFIG_HOME=str(config),XDG_DATA_HOME=str(data),XDG_CURRENT_DESKTOP='X-Generic')
        else:
            opener.write_text(capture)
            opener.chmod(0o700)
        self.env.update(DISPLAY=self.display, PATH=str(directory)+':'+os.environ['PATH'],
                        HARNESS_GUI_BROWSER_LOG=str(self.root/'browser.jsonl'),
                        HARNESS_TEST_OAUTH_PENDING=str(self.pending))
        self.env.pop('WAYLAND_DISPLAY', None)
        self.env.pop('XAUTHORITY', None)
        if self.browser:
            assert shutil.which('xdg-open',path=self.env['PATH'])=='/usr/bin/xdg-open', 'Browser tests must use the real desktop launcher'

    def cli(self, *arguments):
        self.prepare_browser()
        if self.browser: self.env.pop('DISPLAY',None)
        try: return super().cli(*arguments)
        finally: self.env['DISPLAY'] = self.display

    def remote(self, *arguments, data=None):
        return subprocess.check_output(['kitty','@','--to',self.control,*arguments],input=data,env=self.env,stderr=subprocess.PIPE)

    def launch(self, env, command=None):
        if self.ssh:
            env = dict(env, SSH_CONNECTION='192.0.2.10 50000 192.0.2.20 22', SSH_TTY='/dev/pts/77')
        self.master = os.open('/dev/null',os.O_RDONLY)
        self.output = bytearray()
        self.control = 'unix:' + str(self.root/'kitty.sock')
        self.terminal_log = (self.root/'kitty.log').open('wb')
        clipboard = [] if self.clipboard_enabled is None else ['--cmd', 'lua vim.g.clipboard="osc52"' if self.clipboard_enabled else 'let g:loaded_clipboard_provider=0']
        command = command or ['nvim','-u','NONE','-n','-i','NONE',*clipboard,
                              '--cmd','lua dofile(vim.env.HARNESS_REPO .. "/tests/nvim/interactive_init.lua")']
        self.process = subprocess.Popen(['kitty','--config','NONE','--dump-bytes',str(self.root/'terminal.raw'),
            '-o','linux_display_server=x11','-o','allow_remote_control=yes','-o','shell_integration=disabled',
            '-o','font_size=12','-o','initial_window_width=120c','-o','initial_window_height=40c',
            '-o','remember_window_size=no','-o','confirm_os_window_close=0',
            *([] if self.hyperlinks else ['-o','allow_hyperlinks=no']),
            *(['-o','clipboard_control=read-clipboard-ask'] if self.clipboard_enabled is False else []),'--listen-on',self.control,*command],
            cwd=self.root,env=env,stdout=self.terminal_log,stderr=self.terminal_log)
        self.wait(lambda:(self.root/'kitty.sock').exists(),'Kitty starts',timeout=15)
        self.window_id = json.loads(self.remote('ls'))[0]['tabs'][0]['windows'][0]['id']
        if os.environ.get('HARNESS_GUI_VIDEO'):
            assert shutil.which('ffmpeg'), 'HARNESS_GUI_VIDEO requires ffmpeg'
            self.video_log = (self.root/'video.log').open('wb')
            self.video_started = time.monotonic()
            self.video = subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-f','x11grab',
                '-video_size','1280x960','-framerate','15','-draw_mouse','0','-i',self.display,
                '-c:v','libx264','-preset','ultrafast','-crf','18','-pix_fmt','yuv420p','-y',str(self.root/'screen.mkv')],
                stdout=subprocess.DEVNULL,stderr=self.video_log)

    def pump(self, seconds=.08):
        time.sleep(seconds)
        if (self.root/'terminal.raw').exists(): self.output = bytearray((self.root/'terminal.raw').read_bytes())

    def keys(self, text):
        self.remote('send-text','--match','id:'+str(self.window_id),'--stdin',data=text.encode())
        self.pump()

    def record(self):
        self.pump(0)

    def resize(self, columns, lines):
        self.remote('resize-os-window','--match','id:'+str(self.window_id),'--unit','cells',
                    '--width',str(columns),'--height',str(lines))
        self.wait(lambda:self.observe('vim.o.columns')==columns and self.observe('vim.o.lines')==lines,'native desktop resize')

    def mouse(self, button, column, row, modifiers=()):
        """Send real desktop events through Kitty, including its own link handler."""
        assert button==0, 'Desktop login controls use the left mouse button'
        native = json.loads(self.remote('ls'))[0]['platform_window_id']
        columns, lines = self.observe('{vim.o.columns,vim.o.lines}')
        with Desktop(self.display) as desktop:
            desktop.click(native, column, row, columns, lines, modifiers)
        self.pump(.3)

    def mark(self, text):
        if self.video: self.steps.append({'time':round(time.monotonic()-self.video_started,2),'text':text})

    def screenshot(self, name):
        self.remote('screenshot','--match','id:'+str(self.window_id),str(self.root/(name+'.png')))

    def clipboard(self):
        """Paste from Kitty's actual system clipboard into a separate raw terminal."""
        target = self.root/'clipboard.txt'
        ready = self.root/'clipboard-ready'
        target.unlink(missing_ok=True)
        ready.unlink(missing_ok=True)
        program = ('import os,pathlib,select,sys,tty; tty.setraw(0); '
                   'pathlib.Path(sys.argv[2]).touch(); data=b""\n'
                   'while select.select([0],[],[],5 if not data else .2)[0]: data+=os.read(0,65536)\n'
                   'pathlib.Path(sys.argv[1]).write_bytes(data)\n')
        receiver = self.remote('launch','--type=tab','--title=Clipboard receiver','python3','-c',program,str(target),str(ready)).decode().strip()
        self.wait(ready.exists,'independent clipboard receiver')
        self.remote('action','--match','id:'+receiver,'paste_from_clipboard')
        self.wait(target.exists,'native Kitty clipboard paste',timeout=8)
        self.wait(lambda:any(window['id']==self.window_id and window['is_focused']
                           for os_window in json.loads(self.remote('ls')) for tab in os_window['tabs'] for window in tab['windows']),
                  'return from clipboard receiver')
        return target.read_bytes()

    def finish(self):
        if self.browser: self.browser.close()
        if self.video:
            self.video.send_signal(signal.SIGINT)
            self.video.wait(timeout=15)
            self.video_log.close()
        super().finish()
        self.terminal_log.close()
        self.finished = True

    def abort(self):
        if self.finished: return
        if self.browser: self.browser.close()
        if getattr(self,'process',None) and self.alive():
            self.keys('\x1c\x0e:noautocmd qa!\r')
            try: self.process.wait(timeout=5)
            except subprocess.TimeoutExpired: self.process.terminate(); self.process.wait(timeout=5)
        if self.video and self.video.poll() is None:
            self.video.send_signal(signal.SIGINT)
            self.video.wait(timeout=15)
        for _ in range(50):
            try: self.cli('shutdown'); break
            except AssertionError: time.sleep(.1)



def login(editor, provider, method):
    editor.command('Harness login '+provider)
    item = next(item for item in editor.rpc.request('configuration.get')['providers'] if item['id']==provider)
    if len(item['methods'])>1: editor.choose(method)
    editor.wait(lambda:editor.observe('vim.fn.mode(1)')=='t','private input is immediately ready')


def bounded(editor):
    window = next(window for window in editor.windows() if window['name']=='harness://setup')
    return (window['col']>=1 and window['row']>=1 and window['col']+window['width']<=editor.observe('vim.o.columns')
            and window['row']+window['height']<editor.observe('vim.o.lines'))


def complete_account(editor, copied):
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(copied).query)
    assert {'state','code_challenge','redirect_uri'}<=query.keys()
    callback = query['redirect_uri'][0]+'?'+urllib.parse.urlencode({'code':'test-code','state':query['state'][0],'client_id':'test-issued-client'})
    assert urllib.parse.urlsplit(callback).hostname in ('127.0.0.1','localhost')
    with urllib.request.urlopen(callback,timeout=5) as response: assert response.status==200
    editor.wait(lambda:not any(window['name'] in ('harness://setup','harness://login-link') for window in editor.windows()),'callback from the pasted URL completes login')

def open_link(editor):
    editor.wait(lambda:editor.browser_urls(),'the editor opens the browser when the login link is ready')


def click_terminal_link(editor, modifiers=()):
    window = next(window for window in editor.windows() if window['name']=='harness://setup')
    row = next(index for index,line in enumerate(window['lines'],1) if line=='[ Open browser ]')
    position = editor.observe('vim.fn.screenpos('+str(window['id'])+','+str(row)+',8)')
    assert position['row']>0 and position['col']>0, 'The browser action must be visible'
    editor.mouse(0,position['col'],position['row'],modifiers)


def account_case(display):
    editor = GuiEditor('login-url-native-clipboard',display,hyperlinks=False)
    editor.keys('iUnsent task remains here.')
    login(editor,'openai','Sign in with ChatGPT')
    open_link(editor)
    expected = editor.browser_urls()[0]
    assert len(expected)>200
    assert not any('https://' in line for window in editor.windows() if window['name']=='harness://setup' for line in window['lines']), 'The default login screen must not expose a wrapped URL to terminal link detection'
    assert editor.observe('vim.fn.mode(1)')=='t'
    editor.mark('The browser opens automatically. Click the short browser action without copying a link.')
    click_terminal_link(editor)
    editor.wait(lambda:len(editor.browser_urls())==2,'ordinary desktop click opens the complete URL without leaving input first')
    assert editor.browser_urls()[-1]==expected
    editor.mark('Ctrl-Shift-click cannot open a partial URL when terminal hyperlinks are unavailable.')
    click_terminal_link(editor,modifiers=(0xffe3,0xffe1))
    assert editor.browser_urls()==[expected,expected], 'A terminal without OSC8 must not detect a truncated URL or popup border'
    editor.mark('Copy the complete browser link with Ctrl-X; paste it in a separate terminal.')
    editor.keys('\x18')
    copied = editor.clipboard().decode()
    assert copied==expected, 'Copy must preserve the entire URL, without wrapped lines or terminal borders'
    assert editor.observe('vim.fn.mode(1)')=='t'
    editor.keys('\x0f')
    editor.wait(lambda:len(editor.browser_urls())==3,'visible Open action invokes the desktop handler')
    assert editor.browser_urls()[-1]==copied
    editor.mark('Ctrl-L shows the full link. Native selection copies the complete logical line.')
    editor.keys('\x0c')
    editor.wait(lambda:editor.observe('vim.api.nvim_buf_get_name(0)')=='harness://login-link','full link view')
    editor.keys('"+y$')
    assert editor.clipboard()==copied.encode(), 'A native yank must include the complete wrapped link'
    editor.keys('2j0"+yw')
    assert editor.clipboard()==b'Complete ', 'Native selection also copies ordinary full-link view text'
    editor.keys('\r')
    editor.wait(lambda:editor.observe('vim.fn.mode(1)')=='t','Enter returns to private login input')
    window = next(window for window in editor.windows() if window['name']=='harness://setup')
    editor.mark('The Copy and Open buttons use the same complete link.')
    editor.mouse(0,window['col']+22,window['row']+1)
    assert editor.observe('vim.fn.mode(1)')=='t', 'Mouse Copy must leave private input ready'
    assert editor.clipboard().decode()==copied, 'Mouse Copy must replace the selected help text with the exact URL'
    editor.mouse(0,window['col']+3,window['row']+1)
    editor.wait(lambda:len(editor.browser_urls())==4,'mouse Open invokes the desktop handler')
    assert editor.browser_urls()[-1]==copied
    assert editor.observe('vim.fn.mode(1)')=='t', 'Mouse Open must leave private input ready'
    editor.keys('\x1c\x0e')
    assert editor.observe('vim.fn.mode(1)')=='nt', 'Native terminal selection must remain available after Copy and Open'
    editor.keys('i')
    assert editor.observe('vim.fn.mode(1)')=='t'
    observed = {
        'copied_url_bytes':len(copied.encode()),'copied_url_sha256':hashlib.sha256(copied.encode()).hexdigest(),
        'copied_equals_full_browser_url':True,'native_clipboard_provider':'Neovim OSC52',
        'native_paste_receiver':'separate Kitty terminal','open_action_uses_same_url':True,
        'mouse_input':'actual XTest desktop events','terminal_hyperlinks':False,
        'automatic_browser_open':True,'terminal_modifier_click_cannot_open_truncated_url':True,
        'callback_source':'native clipboard paste'}
    editor.screenshot('complete-link-controls')
    editor.mark('The login window fits a narrow terminal. Copy still returns the full link.')
    editor.resize(60,20)
    editor.wait(lambda:bounded(editor),'login fits a narrow terminal')
    editor.keys('\x18')
    assert editor.clipboard().decode()==copied, 'Resizing must not change the copied URL'
    editor.screenshot('narrow-link-controls')
    editor.keys('\x1b')
    editor.wait(lambda:editor.observe('vim.fn.mode(1)')=='nt','Escape permits native terminal navigation')
    click_terminal_link(editor)
    editor.wait(lambda:len(editor.browser_urls())==5,'a normal click on the resized browser action opens the complete URL')
    assert editor.browser_urls()[-1]==copied
    editor.mark('Return to the full terminal, then click Link while browser sign-in completes.')
    editor.resize(120,40)
    window = next(window for window in editor.windows() if window['name']=='harness://setup')
    editor.mouse(0,window['col']+33,window['row']+1)
    editor.wait(lambda:editor.observe('vim.api.nvim_buf_get_name(0)')=='harness://login-link','mouse Link shows the complete URL while browser callback waits')
    assert editor.observe('vim.fn.mode(1)')=='n', 'Mouse Link must permit native selection'
    assert len(editor.browser_urls())==5, 'Opening Full link must not also open the browser'
    editor.mouse(0,window['col']+10,window['row']+3)
    editor.wait(lambda:len(editor.browser_urls())==6,'an ordinary click on the wrapped link opens the browser')
    assert editor.browser_urls()[-1]==copied
    editor.mouse(0,window['col']+3,window['row']+1)
    editor.wait(lambda:len(editor.browser_urls())==7,'Open browser also works from Full link')
    assert editor.browser_urls()[-1]==copied and editor.observe('vim.fn.mode(1)')=='n'
    editor.screenshot('full-link-browser-actions')
    complete_account(editor,copied)
    editor.wait(lambda:editor.observe('vim.fn.mode(1)')=='i','return to the unchanged draft')
    editor.mark('Sign-in completes. Continue the exact unsent draft immediately.')
    editor.keys(' More text.')
    assert editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)')==['Unsent task remains here. More text.']
    assert not editor.snapshot()['entries']
    observed['steps'] = editor.steps
    (editor.root/'observed.json').write_text(json.dumps(observed,indent=2)+'\n')
    editor.finish()


def device_case(display):
    editor = GuiEditor('device-code-native-clipboard',display,pending=100000,clipboard=None)
    login(editor,'github-copilot','GitHub Copilot')
    editor.wait(lambda:b'GitHub Enterprise URL/domain' in editor.output,'optional enterprise-domain prompt')
    editor.keys('\r')
    open_link(editor)
    editor.keys('\x18')
    assert editor.clipboard().decode()==editor.browser_urls()[0]
    editor.keys('\x19')
    assert editor.clipboard()==b'TEST-CODE', 'Copy code must use the complete device code rather than the URL'
    assert b'E319' not in editor.output, 'Default device copy must not show a missing clipboard provider error'
    assert editor.observe('vim.g.clipboard == nil'), 'Device copy must not replace the user clipboard configuration'
    editor.screenshot('device-code-copy')
    editor.keys('\x03')
    editor.wait(lambda:not any(window['name']=='harness://setup' for window in editor.windows()),'cancel device login')
    assert editor.observe('vim.fn.mode(1)')=='i'
    editor.keys('Unsent after device cancel.')
    assert editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)')==['Unsent after device cancel.']
    login(editor,'openai','OpenAI API key')
    editor.wait(lambda:b'Enter OpenAI API key' in editor.output,'private API key prompt after device login')
    editor.keys('synthetic-hidden-key')
    editor.keys('\x18')
    assert editor.clipboard()==b'TEST-CODE', 'API key input must not copy a credential or reuse an old login URL'
    assert b'synthetic-hidden-key' not in editor.output
    window = next(window for window in editor.windows() if window['name']=='harness://setup')
    editor.mouse(0,window['col']+3,window['row']+1)
    editor.wait(lambda:not any(window['name']=='harness://setup' for window in editor.windows()),'mouse Cancel closes API key input')
    assert editor.observe('vim.fn.mode(1)')=='i'
    editor.keys(' After API cancel.')
    assert editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)')==['Unsent after device cancel. After API cancel.']
    assert not editor.snapshot()['entries']
    (editor.root/'observed.json').write_text(json.dumps({'device_url_copied_exactly':True,'device_code_pasted':'TEST-CODE','api_key_not_copied':True,'both_cancellations_retained_exact_draft':True},indent=2)+'\n')
    editor.finish()


def fallback_case(display, default=False):
    editor = GuiEditor('login-copy-default-editor' if default else 'login-copy-without-system-clipboard',display,clipboard=None if default else False)
    editor.keys('iUnsent default task.')
    login(editor,'openai','Sign in with ChatGPT')
    open_link(editor)
    available = editor.observe('vim.fn.has("clipboard")')==1
    before = editor.clipboard() if not default else None
    editor.keys('\x18')
    if default:
        copied = editor.clipboard().decode()
        assert editor.observe('vim.g.clipboard == nil'), 'Default Copy must not change user configuration'
        assert copied==editor.browser_urls()[0], 'Copy must work in ordinary Kitty without user clipboard setup'
    else:
        assert editor.clipboard()==before, 'The controlled terminal denies system clipboard writes'
    editor.keys('\x0c')
    editor.wait(lambda:editor.observe('vim.api.nvim_buf_get_name(0)')=='harness://login-link','selectable full-link fallback')
    editor.screenshot('full-link-native-selection')
    editor.keys('yy\r')
    editor.wait(lambda:editor.observe('vim.fn.mode(1)')=='t','return to login input after native yank')
    if default:
        editor.keys('\x1c\x0e')
        editor.mouse(0,5,2)
        editor.command('buffer '+str(editor.root/'one'))
        editor.keys('A unsaved\x1b')
        file_window = editor.observe('vim.api.nvim_get_current_win()')
        complete_account(editor,copied)
        assert editor.observe('vim.api.nvim_get_current_win()')==file_window
        assert editor.observe('vim.api.nvim_buf_get_name(0)')==str(editor.root/'one')
        assert editor.observe('vim.bo.modified') and editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)')==['one unsaved']
        assert (editor.root/'one').read_text()=='one\n'
    else:
        editor.keys('\x03')
        editor.wait(lambda:not any(window['name']=='harness://setup' for window in editor.windows()),'cancel from restored private input')
        assert editor.observe('vim.fn.mode(1)')=='i'
    assert editor.observe('vim.api.nvim_buf_get_lines(vim.fn.bufnr("harness://prompt/work"),0,-1,false)')==['Unsent default task.']
    editor.command('new copied-link.txt')
    editor.keys('pggdd')
    editor.command('write')
    assert (editor.root/'copied-link.txt').read_text()==editor.browser_urls()[0]+'\n', 'Native paste must preserve the whole link without a clipboard provider'
    assert not editor.snapshot()['entries']
    editor.screenshot('full-link-native-paste')
    (editor.root/'observed.json').write_text(json.dumps({'default_editor_clipboard_configuration':default,'clipboard_provider_available':available,'terminal_clipboard_enabled':default,'callback_preserved_unsaved_file_focus':default,'full_link_native_yank_and_paste':True,'url_bytes':len(editor.browser_urls()[0].encode())},indent=2)+'\n')
    editor.finish()

def browser_case(display):
    editor = GuiEditor('login-browser-delayed-return',display,clipboard=None,browser=True,generation=[{'kind':'answer'}])
    browser = editor.browser
    editor.keys('i\\model openai/gpt-5.6-luna\r')
    editor.wait(lambda:editor.snapshot()['session']['model']=='gpt-5.6-luna','select the reported model')
    editor.keys('Unsent browser task.')
    editor.mark('Select Sign in with ChatGPT. Firefox opens automatically with the complete login link.')
    login(editor,'openai','Sign in with ChatGPT')
    editor.wait(lambda:b'Waiting for browser sign-in. No input is needed here.' in editor.output,'browser callback wait')
    editor.wait(lambda:browser.find('Harness test account 1'),'Firefox opens the test authorization page automatically',timeout=20)
    first = browser.find('Harness test account 1')
    assert len(browser.attempts)==1, 'A new login must open one browser tab'
    browser.screenshot('browser-test-account')
    browser.focus(json.loads(editor.remote('ls'))[0]['platform_window_id'])
    editor.mark('Press Enter with no text. The browser sign-in must stay open.')
    editor.keys('\r')
    editor.keys('   \r')
    assert any(window['name']=='harness://setup' for window in editor.windows()), 'Blank callback input must keep browser sign-in open'
    assert len(browser.attempts)==1
    assert next(item for item in editor.rpc.request('configuration.get')['providers'] if item['id']=='openai')['credential_type']=='api_key'
    assert any(window['name']=='harness://setup' for window in editor.windows()), 'Empty input and a browser delay must not close the login listener'
    editor.mark('Cancel this sign-in in Neovim. The unsent task stays ready.')
    browser.focus(json.loads(editor.remote('ls'))[0]['platform_window_id'])
    editor.keys('\x03')
    editor.wait(lambda:not any(window['name']=='harness://setup' for window in editor.windows()),'cancel the first browser attempt')
    editor.wait(lambda:editor.observe('vim.fn.mode(1)')=='i','cancel returns to input')
    editor.keys(' Retry.')
    assert editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)')==['Unsent browser task. Retry.']
    login(editor,'openai','Sign in with ChatGPT')
    editor.wait(lambda:any('Waiting for browser sign-in. No input is needed here.' in ''.join(window['lines']) for window in editor.windows() if window['name']=='harness://setup'),'retry browser callback wait')
    editor.wait(lambda:browser.find('Harness test account 2'),'Firefox opens the new account attempt automatically',timeout=20)
    browser.focus(json.loads(editor.remote('ls'))[0]['platform_window_id'])
    editor.keys('\r   \r')
    editor.mark('Press Escape as in Vim, then click Open browser without copying a link.')
    editor.keys('\x1b')
    editor.wait(lambda:editor.observe('vim.fn.mode(1)')=='nt','Escape leaves login input without closing the listener')
    click_terminal_link(editor)
    editor.wait(lambda:browser.find('Harness test account 3'),'an actual desktop click opens the complete current login URL',timeout=20)
    second = browser.find('Harness test account 3')
    assert browser.attempts[0]['callback']!=browser.attempts[2]['callback'], 'Retry must have a new OAuth state'
    assert browser.attempts[1]['callback']==browser.attempts[2]['callback'], 'The visible browser action must use the same full URL as automatic opening'
    expected_environment = {'DISPLAY':editor.display,'WAYLAND_DISPLAY':None,'XAUTHORITY':None,
                            'XDG_CONFIG_HOME':str(editor.root/'desktop-config'),'XDG_DATA_HOME':str(editor.root/'desktop-data'),
                            'NVIM':editor.observe('vim.v.servername')}
    assert editor.browser_urls()==[attempt['url'] for attempt in browser.attempts], 'The desktop handler must receive each complete URL unchanged'
    for attempt in browser.attempts:
        environment = dict(item.split('=',1) for item in Path('/proc',str(attempt['pid']),'environ').read_text().split('\0') if '=' in item)
        assert attempt['environment']==expected_environment
        assert {name:environment.get(name) for name in expected_environment}==expected_environment, 'Firefox must inherit the Neovim environment without repair by the test service'
    editor.mark('The cancelled browser page cannot finish the new sign-in.')
    browser.approve(first)
    editor.wait(lambda:'Authentication failed' in browser.title(first),'Firefox displays rejection of the cancelled state')
    assert next(item for item in editor.rpc.request('configuration.get')['providers'] if item['id']=='openai')['credential_type']=='api_key'
    assert any(window['name']=='harness://setup' for window in editor.windows())
    browser.screenshot('browser-cancelled-state')
    editor.mark('Leave the current account page open for 15 seconds, as during a normal sign-in.')
    browser.focus(second)
    editor.pump(15)
    editor.mark('Continue in the current Firefox page. The browser returns to the live local listener.')
    browser.approve(second)
    editor.wait(lambda:'Authentication successful' in browser.title(second),'Firefox displays the actual Pi callback success page',timeout=15)
    editor.wait(lambda:not any(window['name']=='harness://setup' for window in editor.windows()),'browser callback completes private login')
    assert next(item for item in editor.rpc.request('configuration.get')['providers'] if item['id']=='openai')['credential_type']=='oauth'
    browser.screenshot('browser-callback-success')
    editor.wait(lambda:editor.observe('vim.fn.mode(1)')=='i','browser completion returns to the unchanged prompt')
    browser.focus(json.loads(editor.remote('ls'))[0]['platform_window_id'])
    editor.keys(' Done.')
    assert editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)')==['Unsent browser task. Retry. Done.']
    assert not editor.snapshot()['entries']
    requests = [json.loads(line) for line in (editor.root/'oauth-requests.jsonl').read_text().splitlines()]
    assert sum(item.get('grant')=='authorization_code' for item in requests)==1, 'Only the current browser attempt can exchange its code'
    delay = browser.attempts[2]['approved_at']-browser.attempts[2]['opened_at']
    assert delay>=15, 'The successful browser callback must include a human-length sign-in delay'
    editor.mark('Return to Neovim and continue the complete unsent task.')
    editor.screenshot('browser-return-draft')
    editor.mark('Send the retained task. The saved account replaces the environment API key.')
    editor.keys('\r')
    editor.wait(lambda:editor.snapshot()['assistant']['text']=='OpenAI streamed \u03bb \u4e16\u754c and completed the task.'
                and editor.snapshot()['state']=='idle','a task succeeds with the saved account and the selected model')
    generations = [json.loads(line) for line in (editor.root/'generation-requests.jsonl').read_text().splitlines()]
    assert len(generations)==1 and generations[0]['credential_kind']=='oauth'
    assert generations[0]['model']=='gpt-5.6-luna'
    editor.keys('Next task remains ready.')
    assert editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)')==['Next task remains ready.']
    editor.screenshot('browser-account-reply')
    (editor.root/'observed.json').write_text(json.dumps({
        'browser':'actual Firefox with a fresh profile per attempt','external_browser_requests':'blocked by a local proxy',
        'browser_launcher':'actual /usr/bin/xdg-open with a temporary default desktop handler',
        'browser_environment':'inherited unchanged from Neovim through the desktop handler',
        'default_handler_received_complete_url':True,'browser_callback_required_manual_paste':False,
        'browser_profile_paths':['firefox-profile-1','firefox-profile-2','firefox-profile-3'],'user_browser_profile_changed':False,
        'test_browser_proxy':{'type':'manual','http':'127.0.0.1','https':'127.0.0.1','port':browser.server.server_port,
                              'bypass':['localhost','127.0.0.1'],'dns_over_https':False},
        'url_source':'automatic browser launch and actual XTest click on the short Open browser action; no clipboard or RPC URL extraction',
        'callback_source':'Firefox form submission followed by HTTP redirect to the real Pi listener',
        'automatic_browser_open':True,'native_mouse_used_same_complete_url':True,
        'blank_and_whitespace_input_preserved_listener':True,'escape_preserved_listener':True,'browser_wait_seconds':round(delay,2),
        'cancelled_state_rejected_by_real_callback':True,'current_state_authenticated':True,
        'token_exchanges':1,'account_replaced_environment_key':True,'generation_model':'gpt-5.6-luna',
        'generation_credentials':'synthetic OAuth','exact_draft':'Next task remains ready.','steps':editor.steps},indent=2)+'\n')
    editor.finish()


def ssh_copy_case(display):
    editor = GuiEditor('login-ssh-copy-paste',display,clipboard=None,browser=True,ssh=True,generation=[{'kind':'answer'}])
    browser = editor.browser
    assert not editor.env.get('SSH_CONNECTION') and not editor.env.get('SSH_TTY'), 'Only the editor is an SSH client; the running worker has a local environment'
    editor.keys('i\\model openai/gpt-5.6-luna\r')
    editor.wait(lambda:editor.snapshot()['session']['model']=='gpt-5.6-luna','select the model before remote login')
    editor.keys('Unsent SSH task.')
    editor.mark('SSH is detected. The instructions explain that browser sign-in requires copy and paste.')
    login(editor,'openai','Sign in with ChatGPT')
    def instructions():
        return '\n'.join(line for window in editor.windows() if window['name']=='harness://setup' for line in window['lines'])
    editor.wait(lambda:'Paste it below and press Enter.' in instructions(),'SSH copy action and instructions')
    for text in ('SSH: copy this link to your local browser.', '[ Copy link ]',
                 'If the browser cannot connect to localhost or 127.0.0.1,',
                 'this is expected over SSH. Copy the FULL address from its address bar.',
                 'Paste it below and press Enter. If a code is shown, paste that code.'):
        assert text in instructions(), 'The remote instructions must explain the complete copy and paste procedure: '+text
    assert 'No input is needed' not in instructions() and 'Open browser' not in instructions()
    editor.screenshot('ssh-instructions')
    editor.keys('\r   \r')
    assert any(window['name']=='harness://setup' for window in editor.windows()), 'Empty input must keep the remote login ready'
    assert not editor.browser_urls() and not browser.attempts, 'SSH must never launch a browser on the server'
    editor.mark('Cancel before signing in. The unsent task stays in the chat.')
    editor.keys('\x03')
    editor.wait(lambda:not any(window['name']=='harness://setup' for window in editor.windows()),'cancel manual SSH login')
    editor.wait(lambda:editor.observe('vim.fn.mode(1)')=='i','cancellation restores the draft input')
    editor.keys(' Retry.')
    assert editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)')==['Unsent SSH task. Retry.']
    login(editor,'openai','Sign in with ChatGPT')
    editor.wait(lambda:any('[ Copy link ]' in line for window in editor.windows() if window['name']=='harness://setup' for line in window['lines']),'fresh manual SSH login link')
    window = next(window for window in editor.windows() if window['name']=='harness://setup')
    row = next(index for index,line in enumerate(window['lines'],1) if line=='[ Copy link ]')
    position = editor.observe('vim.fn.screenpos('+str(window['id'])+','+str(row)+',8)')
    assert position['row']>0 and position['col']>0, 'The manual Copy link action must be visible'
    editor.mark('Click Copy link. The complete address goes to the local terminal clipboard.')
    editor.mouse(0,position['col'],position['row'])
    copied = editor.clipboard().decode()
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(copied).query)
    assert copied.startswith('https://auth.openai.com/') and {'state','code_challenge','redirect_uri'}<=query.keys()
    assert query['redirect_uri']==['http://127.0.0.1:1455/auth/callback'] and len(copied)>200
    editor.keys('\x0f')
    assert editor.clipboard().decode()==copied, 'Ctrl-O on SSH must copy the same full link'
    assert not editor.browser_urls() and not browser.attempts, 'Neither SSH action may run the remote desktop opener'
    editor.mark('Open the copied link on the local desktop. Approve the synthetic account in Firefox.')
    with (editor.root/'local-browser.log').open('wb') as log:
        browser.opener = subprocess.Popen(['/usr/bin/xdg-open',copied],env=editor.env,stdout=log,stderr=log)
    editor.wait(lambda:browser.find('Harness test account 1'),'open the copied complete URL in Firefox',timeout=20)
    page = browser.find('Harness test account 1')
    assert editor.browser_urls()==[copied] and len(browser.attempts)==1
    browser.screenshot('ssh-local-browser')
    browser.approve(page)
    editor.wait(lambda:browser.blocked_callbacks,'the browser cannot reach the remote loopback callback',timeout=15)
    editor.wait(lambda:'Problem loading page' in browser.title(page),'Firefox displays the expected callback connection error',timeout=15)
    assert next(item for item in editor.rpc.request('configuration.get')['providers'] if item['id']=='openai')['credential_type']=='api_key'
    assert any(window['name']=='harness://setup' for window in editor.windows()), 'The browser connection failure must leave manual login ready'
    browser.screenshot('ssh-expected-callback-error')
    editor.mark('The callback connection error is expected over SSH. Copy the complete browser address.')
    browser.key(page,ord('l'),modifiers=(0xffe3,))
    editor.pump(.2)
    browser.key(page,ord('c'),modifiers=(0xffe3,))
    editor.pump(.2)
    browser.focus(json.loads(editor.remote('ls'))[0]['platform_window_id'])
    returned = editor.clipboard().decode()
    assert returned==browser.attempts[0]['callback'], 'Copy from the Firefox address bar must preserve the complete callback'
    editor.mark('Paste the browser address into Neovim and press Enter. The saved account completes login.')
    editor.remote('action','--match','id:'+str(editor.window_id),'paste_from_clipboard')
    editor.keys('\r')
    editor.wait(lambda:not any(window['name']=='harness://setup' for window in editor.windows()),'manual callback paste completes the real Pi login')
    assert next(item for item in editor.rpc.request('configuration.get')['providers'] if item['id']=='openai')['credential_type']=='oauth'
    editor.wait(lambda:editor.observe('vim.fn.mode(1)')=='i','manual login returns to the unchanged prompt')
    assert editor.observe('vim.api.nvim_buf_get_lines(0,0,-1,false)')==['Unsent SSH task. Retry.']
    assert not editor.snapshot()['entries']
    editor.screenshot('ssh-return-draft')
    editor.mark('Send the retained task. Pi uses the saved account and returns the controlled model response.')
    editor.keys('\r')
    editor.wait(lambda:editor.snapshot()['assistant']['text']=='OpenAI streamed \u03bb \u4e16\u754c and completed the task.' and editor.snapshot()['state']=='idle','a task succeeds after manual SSH login')
    generations = [json.loads(line) for line in (editor.root/'generation-requests.jsonl').read_text().splitlines()]
    assert len(generations)==1 and generations[0]['credential_kind']=='oauth' and generations[0]['model']=='gpt-5.6-luna'
    editor.screenshot('ssh-account-reply')
    (editor.root/'observed.json').write_text(json.dumps({
        'ssh_environment':'SSH_CONNECTION and SSH_TTY on the actual editor only; no SSH transport is used',
        'worker_environment':'no SSH variables; client selects manual login',
        'browser':'actual Firefox and /usr/bin/xdg-open with synthetic account replies',
        'callback_boundary':'controlled browser proxy closes loopback requests to represent an unreachable remote callback',
        'no_automatic_remote_browser':True,'ssh_instructions_visible':True,'native_mouse_copy':True,
        'full_authorization_url_copied':True,'blank_input_preserved_login':True,'cancellation_preserved_draft':True,
        'browser_error_expected':True,'callback_source':'Firefox address bar Ctrl-L, Ctrl-C; actual Kitty clipboard paste into Neovim',
        'callback_paste_authenticated':True,'account_replaced_environment_key':True,'generation_model':'gpt-5.6-luna',
        'generation_credentials':'synthetic OAuth','steps':editor.steps},indent=2)+'\n')
    editor.finish()


def main():
    with desktop() as display:
        try:
            account_case(display)
            device_case(display)
            fallback_case(display)
            fallback_case(display,default=True)
            browser_case(display)
            ssh_copy_case(display)
        finally:
            for editor in GuiEditor.instances: editor.abort()
    report = {**DESKTOP,'mode':'Actual Kitty/Xvfb desktop, Neovim, Rust, Pi and Firefox; native clipboard paste and browser callbacks',
              'kitty_version':subprocess.check_output(['kitty','--version'],text=True).strip(),
              'xvfb_executable':os.environ.get('HARNESS_TEST_XVFB') or shutil.which('Xvfb'),
              'xvfb_sha256':hashlib.sha256(Path(os.environ.get('HARNESS_TEST_XVFB') or shutil.which('Xvfb')).read_bytes()).hexdigest(),
              'credentials':'synthetic only','url_source':'automatic launch, native desktop mouse, or copy and actual system paste; no RPC URL extraction',
              'cases':RESULTS}
    for case in report['cases']:
        directory = Path(case['terminal']).parent
        case['checks'] = json.loads((directory/'observed.json').read_text())
        case['screenshots'] = {path.name:hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(directory.glob('*.png'))}
        if (directory/'screen.mkv').exists(): case['video_sha256'] = hashlib.sha256((directory/'screen.mkv').read_bytes()).hexdigest()
    return report


if __name__=='__main__':
    run_tests(main, keep=bool(os.environ.get('HARNESS_GUI_VIDEO')))
