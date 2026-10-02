# Privacy Policy for Steply

**Effective Date:** May 29, 2026  
**Last Updated:** October 2, 2026

## 🛡️ Summary: Privacy by Design
Steply is built with a **Privacy-First** architecture. 
- **100% Local Storage:** Everything you record is stored exclusively on your device using IndexedDB.
- **No Data Collection:** We do not collect your name, email, IP address, or any identifying information.
- **No Tracking:** We use zero analytics, zero cookies, and zero third-party tracking scripts.
- **No Cloud Dependency & No Remote Code:** Steply has no backend servers and relies on no remotely hosted code. Your data never leaves your machine.
- **Local Document Generation:** Every PDF, Word, Markdown, HTML and JSON file Steply produces is assembled inside your own browser. Nothing is uploaded for conversion or rendering.

---

## 🔍 What We Collect
- **Personal Information:** None. Steply does not require an account or any registration.
- **Usage Data:** None. We do not track how many guides you create or which websites you visit.
- **Recorded Data:** All guides, steps, and screenshots stay strictly within your browser's local storage.

## 🛠️ Permissions Explained
Steply requests the following permissions to function. We only use these for the purposes listed:

| Permission | Purpose |
|---|---|
| `activeTab` | To capture a screenshot of the current page when you explicitly record a step, or when you ask Steply to save the page as a PDF. |
| `<all_urls>` | To allow the extension to function on any website you choose to document. |
| `storage` / `unlimitedStorage` | To save your guides locally so they are available when you restart your browser. |

Steply requests **no other permissions**. In particular it does not use the `downloads`
permission (files are saved through an ordinary browser download, the same way clicking a
link does), the `debugger` permission, or any host access beyond the above.

## 📄 Saving a Page as PDF
Steply can scroll the page you are on, capture it a screen at a time, and save the whole
thing as a PDF. This feature is deliberately separate from recording:

- **It is never stored.** The capture is not saved as a guide and is never written to IndexedDB. The only lasting copy is the PDF file you download.
- **It is held briefly, then deleted.** Because the screenshots are assembled on a separate extension page, they are passed to it through your browser's local extension storage. That temporary copy is deleted as soon as the PDF is built, and any leftover from an abandoned capture is cleared the next time you start one.
- **It stays on your device.** The PDF is assembled by JavaScript running in your browser and handed to Chrome's normal download mechanism. The page content is not uploaded anywhere.
- **It does not touch your recordings.** Using it while recording does not add a step to, or otherwise alter, the guide being recorded.

## 🔒 Redaction & Control
Steply includes a **Local Redaction Tool** that allows you to blur sensitive information (PII, passwords, etc.) before exporting or sharing. 
- **Local Processing:** The blurring/redaction happens entirely on your machine using an offscreen canvas. No image data is ever sent to a server for processing.

## 📤 Data Retention & Deletion
- **User Control:** You can delete any guide at any time from the Steply dashboard, which permanently removes it from local storage.
- **Uninstallation:** Uninstalling the Steply extension from Chrome will automatically remove all locally stored data.

## 🏢 Third-Party Services
Steply does not integrate with, share data with, or rely on any third-party services, APIs, or SDKs. 

## ✉️ Contact
If you have any questions about this policy, please reach out:
- **Email:** bevarasaikumar121@gmail.com
