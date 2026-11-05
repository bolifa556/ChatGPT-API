The gateway-test certificate and private key are public, test-only fixtures.
They contain no production credentials and are excluded from release payloads.
The network test trusts the certificate only in a child Node.js process using
NODE_EXTRA_CA_CERTS; no system trust store or certificate validation is changed.
The self-signed certificate covers gateway-transport.test and the loopback
addresses 127.0.0.1 / 127.0.0.2, with a ten-year validity from November 2026.
