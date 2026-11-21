chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'ywd-link', title: 'Download with You Want Download', contexts: ['link'] });
});
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== 'ywd-link' || !info.linkUrl) return;
  if (!/^https?:\/\//i.test(info.linkUrl)) return;
  const deepLink = 'ywd://download?url=' + encodeURIComponent(info.linkUrl);
  chrome.tabs.create({ url: deepLink });
});
