// Browser.close flushes extension/profile state. SIGTERM is only a fallback.
export async function closeBrowser(cdp,chrome){
  try{await cdp.call('Browser.close');}catch{chrome.kill('SIGTERM');}
}
