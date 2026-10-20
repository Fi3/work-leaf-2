#!/usr/bin/env python3
"""Test the actual desktop clipboard and login controls in Kitty and Neovim."""
import contextlib
import ctypes
import hashlib
import json
import os
import shutil
import signal
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path

from real import RealEditor, EVIDENCE, RESULTS

DESKTOP = {}


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
            x11 = ctypes.CDLL('libX11.so.6')
            x11.XOpenDisplay.restype = ctypes.c_void_p
            x11.XVendorRelease.argtypes = x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
            connection = x11.XOpenDisplay(display.encode())
            assert connection, 'Cannot inspect the actual X display'
            DESKTOP['xvfb_vendor_release'] = x11.XVendorRelease(connection)
            x11.XCloseDisplay(connection)
            yield display
        finally:
            process.terminate()
            process.wait(timeout=10)


class GuiEditor(RealEditor):
    instances = []

    def __init__(self, name, display, pending=0, clipboard=True):
        self.display, self.pending = display, pending
        self.clipboard_enabled, self.finished = clipboard, False
        self.video = None
        self.steps = []
        self.instances.append(self)
        super().__init__(name, active=False, oauth_mock=True)
        self.observe('true')

    def cli(self, *arguments):
        directory = self.root/'bin'
        directory.mkdir(exist_ok=True)
        opener = directory/'xdg-open'
        opener.write_text('#!/usr/bin/env python3\nimport json,os,sys\nwith open(os.environ["HARNESS_GUI_BROWSER_LOG"],"a") as output: output.write(json.dumps(sys.argv[1:])+"\\n")\n')
        opener.chmod(0o700)
        self.env.update(DISPLAY=self.display, PATH=str(directory)+':'+os.environ['PATH'],
                        HARNESS_GUI_BROWSER_LOG=str(self.root/'browser.jsonl'),
                        HARNESS_TEST_OAUTH_PENDING=str(self.pending))
        self.env.pop('WAYLAND_DISPLAY', None)
        self.env.pop('XAUTHORITY', None)
        return super().cli(*arguments)

    def remote(self, *arguments, data=None):
        return subprocess.check_output(['kitty','@','--to',self.control,*arguments],input=data,env=self.env,stderr=subprocess.PIPE)

    def launch(self, env, command=None):
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

    def mark(self, text):
        if self.video: self.steps.append({'time':round(time.monotonic()-self.video_started,2),'text':text})

    def screenshot(self, name):
        self.remote('screenshot','--match','id:'+str(self.window_id),str(self.root/(name+'.png')))

    def browser_urls(self):
        path = self.root/'browser.jsonl'
        return [json.loads(line)[0] for line in path.read_text().splitlines()] if path.exists() else []

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
        if self.video:
            self.video.send_signal(signal.SIGINT)
            self.video.wait(timeout=15)
            self.video_log.close()
        super().finish()
        self.terminal_log.close()
        self.finished = True

    def abort(self):
        if self.finished: return
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


def choose(editor, label):
    editor.wait(lambda:any(window['name']=='harness://select' and any(label in line for line in window['lines'])
                           for window in editor.windows()),'visible choice '+label)
    lines = next(window['lines'] for window in editor.windows() if window['name']=='harness://select')
    row = next(index for index,line in enumerate(lines,1) if label in line)
    editor.keys(str(row)+'G\r')


def login(editor, provider, method):
    editor.command('Harness login '+provider)
    item = next(item for item in editor.rpc.request('configuration.get')['providers'] if item['id']==provider)
    if len(item['methods'])>1: choose(editor,method)
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


def account_case(display):
    editor = GuiEditor('login-url-native-clipboard',display)
    editor.keys('iUnsent task remains here.')
    login(editor,'openai','Sign in with ChatGPT')
    editor.wait(lambda:editor.browser_urls(),'initial complete browser URL')
    expected = editor.browser_urls()[0]
    assert len(expected)>200
    editor.mark('Copy the complete browser link with Ctrl-X; paste it in a separate terminal.')
    editor.keys('\x18')
    copied = editor.clipboard().decode()
    assert copied==expected, 'Copy must preserve the entire URL, without wrapped lines or terminal borders'
    assert editor.observe('vim.fn.mode(1)')=='t'
    editor.keys('\x0f')
    editor.wait(lambda:len(editor.browser_urls())==2,'visible Open action invokes the desktop handler')
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
    editor.mouse(0,window['col']+3,window['row']+1)
    assert editor.observe('vim.fn.mode(1)')=='t', 'Mouse Copy must leave private input ready'
    assert editor.clipboard().decode()==copied, 'Mouse Copy must replace the selected help text with the exact URL'
    editor.mouse(0,window['col']+18,window['row']+1)
    editor.wait(lambda:len(editor.browser_urls())==3,'mouse Open invokes the desktop handler')
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
        'callback_source':'native clipboard paste'}
    editor.screenshot('complete-link-controls')
    editor.mark('The login window fits a narrow terminal. Copy still returns the full link.')
    editor.resize(60,20)
    editor.wait(lambda:bounded(editor),'login fits a narrow terminal')
    editor.keys('\x18')
    assert editor.clipboard().decode()==copied, 'Resizing must not change the copied URL'
    editor.screenshot('narrow-link-controls')
    editor.mark('Return to the full terminal, then click Link while browser sign-in completes.')
    editor.resize(120,40)
    window = next(window for window in editor.windows() if window['name']=='harness://setup')
    editor.mouse(0,window['col']+31,window['row']+1)
    editor.wait(lambda:editor.observe('vim.api.nvim_buf_get_name(0)')=='harness://login-link','mouse Link shows the complete URL while browser callback waits')
    assert editor.observe('vim.fn.mode(1)')=='n', 'Mouse Link must permit native selection'
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
    editor.wait(lambda:editor.browser_urls(),'device sign-in URL')
    editor.keys('\x18')
    assert editor.clipboard().decode()==editor.browser_urls()[0]
    editor.keys('\x19')
    assert editor.clipboard()==b'TEST-CODE', 'Copy code must use the complete device code rather than the URL'
    assert b'E319' not in editor.output, 'Default device copy must not show a missing clipboard provider error'
    assert editor.observe('vim.g.clipboard == nil'), 'Device copy must not replace the user clipboard configuration'
    editor.screenshot('device-code-copy')
    editor.keys('\x1b')
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
    editor.wait(lambda:editor.browser_urls(),'browser URL without clipboard provider')
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
        editor.keys('\x1b')
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


def main():
    with desktop() as display:
        try:
            account_case(display)
            device_case(display)
            fallback_case(display)
            fallback_case(display,default=True)
        finally:
            for editor in GuiEditor.instances: editor.abort()
    report = {**DESKTOP,'mode':'Actual Kitty/Xvfb desktop, Neovim, Rust and Pi; native clipboard paste and controlled desktop opener',
              'kitty_version':subprocess.check_output(['kitty','--version'],text=True).strip(),
              'xvfb_executable':os.environ.get('HARNESS_TEST_XVFB') or shutil.which('Xvfb'),
              'xvfb_sha256':hashlib.sha256(Path(os.environ.get('HARNESS_TEST_XVFB') or shutil.which('Xvfb')).read_bytes()).hexdigest(),
              'credentials':'synthetic only','url_source':'normal copy action and actual system paste; no RPC URL extraction',
              'cases':RESULTS}
    for case in report['cases']:
        directory = Path(case['terminal']).parent
        case['checks'] = json.loads((directory/'observed.json').read_text())
        case['screenshots'] = {path.name:hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(directory.glob('*.png'))}
        if (directory/'screen.mkv').exists(): case['video_sha256'] = hashlib.sha256((directory/'screen.mkv').read_bytes()).hexdigest()
    (EVIDENCE/'results.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'passed':len(RESULTS),'evidence':str(EVIDENCE/'results.json')}))


if __name__=='__main__':
    main()
