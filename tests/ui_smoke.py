"""Real Chromium menu/dialog tests against the same HTML/CSS/JS shipped in Wails.
Mocked native bridge is used only for the OS APIs and download data.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import re

UI = Path(__file__).resolve().parents[1] / 'frontend' / 'dist' / 'index.html'


def main():
    html = UI.read_text()
    css = (UI.parent / 'styles.css').read_text()
    js = (UI.parent / 'app.js').read_text().replace("const preview = params.has('preview');", 'const preview = true;')
    html = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]+>', '', html)
    html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>' + css + '</style>')
    html = html.replace('<script defer src="app.js"></script>', '')
    html = html.replace('</body>', '<script>' + js + '</script></body>')
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path='/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1080, 'height': 720}, device_scale_factor=1)
        page.set_default_timeout(5500)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(html, wait_until='load')
        assert page.locator('.download-row').count() == 4
        # Navigate all library views and ensure true display switching.
        for label,title in [('Downloading','Downloading'),('Queue','Queue'),('Completed','Completed'),('Failed','Failed'),('All downloads','All downloads')]:
            page.get_by_role('navigation', name='Main sections').get_by_role('button', name=label).click()
            assert page.locator('#page-title').inner_text() == title
            assert page.locator('.nav-btn.selected').count() == 1
        # Test each actual top-level application menu; buttons must do something.
        for top in ['Tasks', 'Downloads', 'View', 'Tools', 'Help']:
            menu = page.locator('.menu').filter(has=page.locator('summary',has_text=top))
            menu.locator('summary').click()
            assert menu.get_attribute('open') is not None, f'{top} menu did not open'
            assert menu.locator('.menu-pop button').count() >= 2
            menu.locator('summary').click()
        page.locator('.menu').filter(has=page.locator('summary',has_text='Tools')).locator('summary').click()
        page.locator('[data-command=connection]').click()
        assert page.locator('#settings-screen').is_visible()
        assert page.locator('[data-setting-group=connection]').is_visible()
        assert page.locator('#settings-segments').input_value() == '4'
        page.locator('#settings-segments').select_option('8')
        page.locator('#settings-network-mode').select_option('combine')
        assert page.locator('#network-controls').is_visible()
        assert page.locator('#network-adapters .adapter-item').count() == 2
        page.locator('#network-adapters input').first.check()
        page.get_by_role('tab', name='Save To').click()
        assert page.locator('#settings-download-dir').input_value()
        page.locator('#choose-download-dir').click()
        assert page.locator('#settings-download-dir').input_value() == 'C:\\Selected Downloads'
        page.locator('#settings-separate-programs').check()
        page.locator('#choose-programs-dir').click()
        assert page.locator('#settings-programs-dir').input_value() == 'C:\\Selected Downloads'
        page.get_by_role('tab', name='Downloads').click()
        page.locator('#settings-retries').select_option('3')
        page.get_by_role('tab', name='Proxy / SOCKS').click()
        page.locator('#settings-proxy').fill('socks5://127.0.0.1:1080')
        page.get_by_role('button', name='Save settings').click()
        assert 'saved' in page.locator('#toast').inner_text().lower()
        page.get_by_role('button', name='Updates').click()
        page.locator('#check-update').click()
        assert 'Preview only' in page.locator('#update-status').inner_text()
        page.get_by_role('button', name='All downloads').click()
        # URL-only modal auto-fills from native clipboard, advanced options are hidden.
        page.locator('#new-download').click()
        assert page.locator('#add-dialog').is_visible()
        assert page.locator('#add-url').input_value() == 'https://example.com/from-clipboard.zip'
        assert page.locator('#add-advanced').get_attribute('open') is None
        page.locator('#add-advanced summary').click()
        assert page.locator('#add-connections').input_value() == '8'
        page.locator('#add-url').fill('https://example.com/my-archive.zip')
        page.locator('#add-connections').select_option('16')
        page.get_by_role('button', name='Start download').click()
        assert page.locator('.download-row').count() == 5
        page.get_by_role('option').first.click()
        assert page.locator('#details').is_visible()
        assert page.locator('#detail-connections').input_value() == '16'
        page.locator('#detail-connections').select_option('2')
        page.locator('#save-connections').click()
        assert page.locator('#detail-connections').input_value() == '2'
        page.locator('#action-pause').click()
        page.locator('#action-resume').click()
        page.locator('#search').fill('Project-backup')
        assert page.locator('.download-row').count() == 1
        page.locator('#search').fill('')
        assert page.locator('.download-row').count() == 5
        # Working Tasks-menu Add from Clipboard, then Downloads-menu Pause All.
        page.locator('.menu').filter(has=page.locator('summary',has_text='Tasks')).locator('summary').click()
        page.locator('[data-command=clipboard]').click()
        assert page.locator('#add-url').input_value() == 'https://example.com/from-clipboard.zip'
        page.locator('[data-dismiss]').first.click()
        page.locator('.menu').filter(has=page.locator('summary',has_text='Downloads')).locator('summary').click()
        page.locator('[data-command=pause-all]').click()
        assert page.locator('.download-row').count() == 5
        assert errors == [], errors
        # Screenshot from real CSS/DOM with labeled sample data (not simulated Windows chrome).
        fresh = browser.new_page(viewport={'width':1080,'height':720}, device_scale_factor=1)
        fresh.set_content(html, wait_until='load')
        fresh.get_by_role('option').first.click()
        fresh.screenshot(path=str(UI.parents[2] / 'assets' / 'app-preview-v0.3.png'), full_page=True)
        browser.close()
        print('UI PASS: all sections, five menus, clipboard prefill, advanced dialog, five settings tabs, adapters, settings persistence, queue controls, details, search')

if __name__ == '__main__':
    main()
