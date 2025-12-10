// Script to generate self-signed SSL certificates for local development
// Requires OpenSSL to be installed
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const certDir = path.join(__dirname, 'certs');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');
const configPath = path.join(certDir, 'openssl.conf');

// Create certs directory if it doesn't exist
if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir);
}

// Check if certificates already exist
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    console.log('SSL certificates already exist at:', certDir);
    console.log('Regenerating certificates with correct key usage extensions...\n');
    // Delete old certificates
    fs.unlinkSync(keyPath);
    fs.unlinkSync(certPath);
    if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
    }
}

console.log('Generating self-signed SSL certificate using OpenSSL...');
console.log('This may take a moment...\n');

try {
    // Get local IP addresses for Subject Alternative Names
    const networkInterfaces = os.networkInterfaces();
    const ips = ['127.0.0.1', '::1'];
    const dnsNames = ['localhost'];
    
    for (const name of Object.keys(networkInterfaces)) {
        for (const iface of networkInterfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }

    // Create OpenSSL config file with Subject Alternative Names
    const sanEntries = [
        ...dnsNames.map(dns => `DNS:${dns}`),
        ...ips.map(ip => `IP:${ip}`)
    ].join(', ');

    const opensslConfig = `[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
C = US
ST = State
L = City
O = WebRTC Development
CN = localhost

[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = @alt_names

[alt_names]
${dnsNames.map((dns, i) => `DNS.${i + 1} = ${dns}`).join('\n')}
${ips.map((ip, i) => `IP.${i + 1} = ${ip}`).join('\n')}
`;

    // Write OpenSSL config
    fs.writeFileSync(configPath, opensslConfig);

    // Generate private key
    console.log('Generating private key...');
    execSync(`openssl genrsa -out "${keyPath}" 2048`, { stdio: 'inherit' });

    // Generate certificate signing request
    console.log('Creating certificate signing request...');
    const csrPath = path.join(certDir, 'cert.csr');
    execSync(`openssl req -new -key "${keyPath}" -out "${csrPath}" -config "${configPath}"`, { stdio: 'inherit' });

    // Generate self-signed certificate
    console.log('Generating self-signed certificate...');
    execSync(`openssl x509 -req -in "${csrPath}" -signkey "${keyPath}" -out "${certPath}" -days 365 -extensions v3_req -extfile "${configPath}"`, { stdio: 'inherit' });

    // Clean up CSR file
    if (fs.existsSync(csrPath)) {
        fs.unlinkSync(csrPath);
    }

    console.log('\n✓ SSL certificates generated successfully!');
    console.log('  Key:', keyPath);
    console.log('  Cert:', certPath);
    console.log('\n⚠️  Note: Browsers will show a security warning for self-signed certificates.');
    console.log('   This is normal for local development.');
    console.log('   Click "Advanced" → "Proceed to localhost (unsafe)" to continue.');
    console.log('\n   The certificate is valid for:');
    console.log('     - https://localhost:8443');
    ips.filter(ip => ip !== '127.0.0.1' && ip !== '::1').forEach(ip => {
        console.log(`     - https://${ip}:8443`);
    });
} catch (error) {
    console.error('\n✗ Failed to generate certificates.');
    if (error.message.includes('openssl') || error.code === 'ENOENT') {
        console.error('\nOpenSSL is not installed or not in PATH.');
        console.error('\nTo install OpenSSL on Windows:');
        console.error('  1. Download from: https://slproweb.com/products/Win32OpenSSL.html');
        console.error('  2. Install the "Light" version');
        console.error('  3. Add OpenSSL to your PATH, or restart your terminal');
        console.error('\nAlternatively, if you have Git Bash installed, OpenSSL is included.');
        console.error('  You can run this script from Git Bash.');
    } else {
        console.error('Error:', error.message);
    }
    process.exit(1);
}

