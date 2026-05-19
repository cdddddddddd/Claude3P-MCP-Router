/**
 * Pure Node.js self-signed certificate generator using node-forge.
 * No external system dependencies (no openssl/mkcert needed).
 *
 * Self-signed root certs are exempt from Windows SChannel revocation checks,
 * unlike CA-signed certs which fail with CRYPT_E_NO_REVOCATION_CHECK.
 */
import forge from 'node-forge';
const CERT_DAYS = 1825; // 5 years
export function generateCert() {
    const pki = forge.pki;
    // Generate RSA key pair
    const keypair = pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
    // Build certificate
    const cert = pki.createCertificate();
    cert.publicKey = keypair.publicKey;
    cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));
    const now = new Date();
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(now.getTime() + CERT_DAYS * 86400000);
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs); // self-signed
    // Subject Alternative Name
    cert.setExtensions([
        {
            name: 'subjectAltName',
            altNames: [
                { type: 2, value: 'localhost' }, // DNS
                { type: 7, ip: '127.0.0.1' }, // IP
            ],
        },
    ]);
    // Self-sign
    cert.sign(keypair.privateKey, forge.md.sha256.create());
    return {
        cert: pki.certificateToPem(cert),
        key: pki.privateKeyToPem(keypair.privateKey),
    };
}
//# sourceMappingURL=cert.js.map