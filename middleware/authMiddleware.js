const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { promisify } = require('util');

// Create a client to fetch Google's public keys
const client = jwksClient({
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
});
const getSigningKey = promisify(client.getSigningKey.bind(client));

// Google requires these claims
const GOOGLE_AUDIENCE = '206866346769-jeemcd408i929s8puriktea1bovb2mnb.apps.googleusercontent.com'; // ← Replace with your app's client ID
const GOOGLE_ISSUER = 'https://accounts.google.com';

const authMiddleware = async (req, res, next) => {
  // Get the Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];

  // First, verify the token is a JWT and well-formed
  const jwtParts = token.split('.');
  if (jwtParts.length !== 3) {
    return res.status(401).json({ error: 'Invalid token: Not a JWT' });
  }

  // Debug: Decode the header to ensure the right key is fetched
  try {
    const headerBase64 = jwtParts[0];
    // Handle URL-safe and standard base64
    let headerStr;
    try {
      headerStr = Buffer.from(headerBase64, 'base64url').toString('utf8');
    } catch (err) {
      headerStr = Buffer.from(
        headerBase64 + '='.repeat((4 - (headerBase64.length % 4)) % 4),
        'base64'
      ).toString('utf8');
    }
    const header = JSON.parse(headerStr);
  } catch (err) {
    console.error('Failed to decode JWT header:', err);
    return res.status(401).json({ error: 'Invalid token: malformed header' });
  }

  // Now verify the token with Google's public keys
  try {
    // Decode the header to get the key ID (kid)
    const [headerBase64] = token.split('.');
    const header = JSON.parse(
      Buffer.from(headerBase64, 'base64').toString('utf8')
    );

    // Fetch the public key
    const key = await getSigningKey(header.kid);
    const publicKey = key.publicKey || key.rsaPublicKey;

    // Actually verify the JWT (RS256, aud, iss)
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      audience: GOOGLE_AUDIENCE,
      issuer: GOOGLE_ISSUER,
    });
    req.user = decoded;
    next();
  } catch (err) {
    console.error('JWT Error:', err.message, err.stack);
    return res.status(401).json({
      error: 'Unauthorized: Invalid token',
      details: err.message,
    });
  }
};

module.exports = authMiddleware;
