const localtunnel = require('localtunnel');
const { spawn } = require('child_process');
const path = require('path');

(async () => {
  try {
    console.log('⚡ Starting secure tunnel to port 8888...');
    const tunnel = await localtunnel({ port: 8888 });

    console.log('\n================================================================');
    console.log('🚀 YOUR PUBLIC TUNNEL IS ACTIVE!');
    console.log(`👉 Friend Dashboard URL: ${tunnel.url}`);
    console.log('👉 Redirect URI to add in Spotify Dashboard:');
    console.log(`   ${tunnel.url}/callback`);
    console.log('================================================================\n');
    console.log('⚠️ IMPORTANT: Make sure to copy the Redirect URI above and add it');
    console.log('   in your Spotify Developer Dashboard -> App Settings, then save!\n');

    console.log('⚡ Starting Spotify Friends server...');
    const env = { ...process.env, REDIRECT_URI: `${tunnel.url}/callback` };
    const server = spawn('node', [path.join(__dirname, 'server.js')], {
      env,
      stdio: 'inherit',
    });

    server.on('close', (code) => {
      console.log(`Server process exited with code ${code}`);
      tunnel.close();
      process.exit(code);
    });

    tunnel.on('close', () => {
      console.log('Tunnel closed.');
      server.kill();
      process.exit(0);
    });

    // Handle process termination cleanly
    process.on('SIGINT', () => {
      tunnel.close();
      server.kill();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      tunnel.close();
      server.kill();
      process.exit(0);
    });
  } catch (err) {
    console.error('❌ Failed to start tunnel/server:', err.message);
    process.exit(1);
  }
})();
