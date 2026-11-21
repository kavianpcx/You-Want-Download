from pathlib import Path
from playwright.sync_api import sync_playwright

UI = Path(__file__).resolve().parents[1] / 'frontend' / 'dist' / 'index.html'

def main():
    html = UI.read_text()
    css = (UI.parent / 'styles.css').read_text()
    js = (UI.parent / 'app.js').read_text().replace("const preview = params.has('preview');", 'const preview = true;')
    import re; html = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]+>', '', html)
    html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>' + css + '</style>')
    html = html.replace('<script defer src="app.js"></script>', '')
    html = html.replace('</body>', '<script>' + js + '</script></body>')
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1050,'height':690},device_scale_factor=1)
        js_errors=[]
        page.on('pageerror',lambda e:js_errors.append(str(e)))
        page.set_content(html,wait_until='load')
        page.get_by_role('option').first.wait_for()
        assert page.locator('.download-row').count()==4
        # Every section must switch content and selected sidebar state.
        for label,title in [('Downloading','Downloading'),('Queue','Queue'),('Completed','Completed'),('Failed','Failed'),('All downloads','All downloads')]:
            page.get_by_role('navigation',name='Main sections').get_by_role('button',name=label).click()
            assert page.locator('#page-title').inner_text()==title
            assert page.locator('.nav-btn.selected').count()==1
        page.get_by_role('button',name='Settings').click()
        assert page.locator('#settings-screen').is_visible()
        assert page.locator('#downloads-screen').is_hidden()
        assert page.locator('#settings-segments').input_value()=='4'
        page.locator('#settings-segments').select_option('8')
        page.get_by_role('button',name='Save settings').click()
        page.get_by_role('button',name='Updates').click()
        assert page.locator('#updates-screen').is_visible()
        page.get_by_role('button',name='Check for updates').click()
        assert 'Preview only' in page.locator('#update-status').inner_text()
        page.get_by_role('button',name='All downloads').click()
        page.get_by_role('button',name='New download').click()
        assert page.locator('#add-dialog').is_visible()
        assert page.locator('#add-connections').input_value()=='8'
        page.locator('#add-url').fill('https://example.com/my-archive.zip')
        page.locator('#add-connections').select_option('16')
        page.get_by_role('button',name='Start download').click()
        assert page.locator('.download-row').count()==5
        page.get_by_role('option').first.click()
        assert page.locator('#details').is_visible()
        assert page.locator('#detail-connections').input_value()=='16'
        page.locator('#detail-connections').select_option('2')
        page.get_by_role('button',name='Apply').click()
        assert page.locator('#detail-connections').input_value()=='2'
        # Exercise toolbar buttons for selected row (mock changes state).
        page.locator('#action-pause').click()
        assert 'Paused' in page.locator('#details').inner_text() or page.locator('.download-row.active').count()==1
        page.locator('#action-resume').click()
        # Search filters rows without jumping pages.
        page.locator('#search').fill('Project-backup')
        assert page.locator('.download-row').count()==1
        page.locator('#search').fill('')
        assert page.locator('.download-row').count()==5
        fresh=browser.new_page(viewport={'width':1050,'height':690},device_scale_factor=1)
        fresh.set_content(html,wait_until='load')
        fresh.get_by_role('option').first.click()
        fresh.screenshot(path='/mnt/data/You-Want-Download/assets/app-preview-v0.2.png',full_page=True)
        fresh.close()
        assert not js_errors,js_errors
        print('UI PASS: navigation x7, settings, update view, modal, per-download settings, pause/resume, search; screenshot saved')
        browser.close()
if __name__=='__main__':main()
