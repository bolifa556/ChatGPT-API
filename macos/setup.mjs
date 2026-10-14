import { install } from '../payload/macos/install.mjs';

install().catch(error => {
  const key = process.env.CHATGPT_API_KEY;
  console.error(key ? error.message.replaceAll(key, '[redacted]') : error.message);
  process.exitCode = 1;
});
