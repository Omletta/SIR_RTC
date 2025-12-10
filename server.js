const fs = require('fs');
const https = require('https');
const path = require('path');

const WebSocket = require('ws');
const uuid = require('uuid');

// Twilio bits, following https://www.twilio.com/docs/stun-turn
// and taking the account details from the environment as
// security BCP.
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
let twilio;
if (twilioAccountSid && twilioAuthToken) {
    twilio = require('twilio')(twilioAccountSid, twilioAuthToken);
}

const port = 8443; // HTTPS default port (can use 8080 if preferred)
const certDir = path.join(__dirname, 'certs');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

// Check if certificates exist
if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error('\n✗ SSL certificates not found!');
    console.error('Please run: node generate-cert.js');
    console.error('Or: npm run generate-cert\n');
    process.exit(1);
}

// Load SSL certificates
let options;
try {
    options = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    };
    console.log('✓ SSL certificates loaded successfully');
} catch (err) {
    console.error('\n✗ Failed to load SSL certificates:', err.message);
    console.error('Please regenerate certificates: npm run generate-cert\n');
    process.exit(1);
}
 
// We use a HTTPS server for serving static pages. In the real world you'll
// want to separate the signaling server and how you serve the HTML/JS, the
// latter typically through a CDN.
const server = https.createServer(options);

// Add error handling
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n✗ Port ${port} is already in use!`);
        console.error('Please stop the other application or change the port.\n');
    } else if (err.code === 'EACCES') {
        console.error(`\n✗ Permission denied on port ${port}!`);
        console.error('You may need administrator privileges.\n');
    } else {
        console.error('\n✗ Server error:', err.message);
        console.error(err);
    }
    process.exit(1);
});

server.listen(port, '0.0.0.0');
server.on('listening', () => {
    const os = require('os');
    const networkInterfaces = os.networkInterfaces();
    let localIP = 'localhost';
    
    // Find the first non-internal IPv4 address
    for (const name of Object.keys(networkInterfaces)) {
        for (const iface of networkInterfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIP = iface.address;
                break;
            }
        }
        if (localIP !== 'localhost') break;
    }
    
    // Get all IP addresses for better visibility
    const allIPs = [];
    for (const name of Object.keys(networkInterfaces)) {
        for (const iface of networkInterfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                allIPs.push({name, address: iface.address});
            }
        }
    }
    
    console.log('\n========================================');
    console.log('HTTPS Server is running!');
    console.log('========================================');
    console.log('Local access: https://localhost:' + port);
    console.log('\nNetwork access (use on other devices):');
    allIPs.forEach(({name, address}) => {
        console.log(`  - https://${address}:${port} (${name})`);
    });
    console.log('\n⚠️  Note: You will see a security warning for self-signed certificates.');
    console.log('   Click "Advanced" → "Proceed to localhost (unsafe)" to continue.');
    console.log('\n💡 Tip: Use the IP address that matches your Wi-Fi/Ethernet network');
    console.log('   (not VirtualBox or other virtual adapters)');
    console.log('========================================\n');
});
server.on('request', (request, response) => {
    // Add security headers
    const headers = {
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
    };
    
    // Parse URL to handle query strings and fragments
    // Handle cases where URL might not have a host
    let pathname = request.url.split('?')[0].split('#')[0]; // Simple pathname extraction
    try {
        if (request.headers.host) {
            const url = new URL(request.url, `https://${request.headers.host}`);
            pathname = url.pathname;
        }
    } catch (e) {
        // Fallback to simple parsing if URL constructor fails
        pathname = request.url.split('?')[0].split('#')[0];
    }
    
    // Log requests for debugging (skip favicon requests)
    if (!pathname.includes('favicon')) {
        console.log(`${new Date().toISOString()} - ${request.method} ${pathname}`);
    }
    
    // Simple connectivity test endpoint
    if (pathname === '/test' || pathname === '/test/') {
        response.writeHead(200, {
            ...headers,
            'Content-Type': 'application/json'
        });
        response.end(JSON.stringify({
            status: 'ok',
            message: 'HTTPS server is reachable!',
            timestamp: new Date().toISOString(),
            protocol: 'https'
        }));
        return;
    }
    
    const urlToPath = {
        '/': 'static/index.html',
        '/no-autodial': 'static/no-autodial.html',
        '/main.js': 'static/main.js',
        '/main.css': 'static/main.css',
    };
    const urlToContentType = {
        '/': 'text/html',
        '/no-autodial': 'text/html',
        '/main.js': 'application/javascript',
        '/main.css': 'text/css',
    };
    const filename = urlToPath[pathname];
    if (!filename) {
        // Silently ignore favicon requests
        if (pathname.includes('favicon')) {
            response.writeHead(204, headers);
            response.end();
            return;
        }
        console.log(`404 - File not found: ${pathname}`);
        response.writeHead(404, headers);
        response.end();
        return;
    }
    fs.readFile(filename, (err, data) => {
        if (err) {
            console.log(`404 - Could not read file ${filename}:`, err.message);
            response.writeHead(404, headers);
            response.end();
            return;
        }
        response.writeHead(200, {
            ...headers,
            'Content-Type': urlToContentType[pathname]
        });
        response.end(data);
    });
});

// A map of websocket connections.
const connections = new Map();
// WebSocket server, running alongside the http server.
const wss = new WebSocket.Server({server});

// Generate a (unique) client id.
// Exercise: extend this to generate a human-readable id.
function generateClientId() {
   
    return uuid.v4();
}
 
wss.on('connection', (ws) => {
    // Assign an id to the client. The other alternative is to have the client
    // pick its id and tell us. But that needs handle duplicates. It is preferable
    // if you have ids from another source but requires some kind of authentication.
    const id = generateClientId();
    console.log(id, 'Received new connection');

    if (connections.has(id)) {
        console.log(id, 'Duplicate id detected, closing');
        ws.close();
        return;
    }
    // Store the connection in our map of connections.
    connections.set(id, ws);

    // Send a greeting to tell the client its id.
    ws.send(JSON.stringify({
        type: 'hello',
        id,
    }));

    // Send an ice server configuration to the client. For stun this is synchronous,
    // for TURN it might require getting credentials.
    if (twilio) {
        twilio.tokens.create().then(token => {
            ws.send(JSON.stringify({
                type: 'iceServers',
                iceServers: token.iceServers,
            }));
        });
    } else {
        ws.send(JSON.stringify({
            type: 'iceServers',
            iceServers: [{urls: 'stun:stun.l.google.com:19302'}],
        }));
    }

    // Remove the connection and notify anyone we are in a call with that
    // our socket went away.
    const notifyOnClose = []; // clients to be notified when this socket closes.
    ws.on('close', () => {
        console.log(id, 'Connection closed');
        connections.delete(id); 
        notifyOnClose.forEach(remoteId => {
            const peer = connections.get(remoteId);
            if (!peer) {
                return;
            }
            peer.sendMessage({
                type: 'bye',
                id,
            });
        });
    });

    ws.on('message', (message) => {
        console.log(id, 'received', message);
        let data;
        try  {
            data = JSON.parse(message);
        } catch (err) {
            console.log(id, 'invalid json', err, message);
            return;
        }
        if (!data.id) {
            console.log(id, 'missing id', data);
            return;
        }

        if (!connections.has(data.id)) {
            console.log(id, 'peer not found', data.id);
         
            return;
        }
        const peerId = data.id;
        const peer = connections.get(peerId);

        data.id = id;
        peer.sendMessage(data);

        // Keep some state about established calls.
        ws.trackCallState(data, peerId);
    });

    // Send a message from a peer to our websocket.
    ws.sendMessage = (data) => {
        ws.trackCallState(data, data.id);

        ws.send(JSON.stringify(data), (err) => {
            if (err) {
                console.log(id, 'failed to send to socket', err);
            }
        });
    };
    
    ws.trackCallState = (data, peerId) => {
        switch(data.type) {
        case 'answer':
            notifyOnClose.push(peerId);
            break;
        case 'bye':
            if (notifyOnClose.indexOf(peerId) !== -1) {
                notifyOnClose.splice(notifyOnClose.indexOf(peerId), 1);
            }
            break;
        }
    };
});
