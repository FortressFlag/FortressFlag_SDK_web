import { describeSignatureVerification } from "../testsupport/signatureSuite.js";

// The real-browser lane: jsdom has no Ed25519 and Node's WebCrypto is not chromium's. The
// signature matrix runs here against the browser's own `crypto.subtle`, so a WebCrypto
// behaviour that differs from Node (key import quirks, NotSupportedError shapes) is caught
// where customers run.
describeSignatureVerification("real chromium");
