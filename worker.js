/**
 * ShareGPT Cloudflare Worker
 * A service for sharing chat conversations with random IDs
 */

export default {
  async fetch(request, env, ctx) {
    return await handleRequest(request, env);
  }
};

/**
 * Main request handler
 */
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // POST / - Save conversation
    if (method === 'POST' && path === '/') {
      return await handlePost(request, env, corsHeaders);
    }
    
    // GET /raw/{id} - Return raw HTML directly
    if (method === 'GET' && path.startsWith('/raw/')) {
      const id = path.slice(5); // Remove '/raw/'
      return await handleGet(id, env, corsHeaders, true);
    }
    
    // GET /{id} - Retrieve and display conversation
    if (method === 'GET' && path.length > 1) {
      const id = path.slice(1); // Remove leading slash
      return await handleGet(id, env, corsHeaders);
    }
    
    // GET / - Show upload form
    if (method === 'GET' && path === '/') {
      return new Response(getUploadForm(), {
        headers: { ...corsHeaders, 'Content-Type': 'text/html' }
      });
    }

    return new Response('Not Found', { 
      status: 404,
      headers: corsHeaders 
    });

  } catch (error) {
    console.error('Error:', error);
    return new Response(`Error: ${error.message}`, { 
      status: 500,
      headers: corsHeaders 
    });
  }
}

/**
 * Handle POST request to save conversation
 */
async function handlePost(request, env, corsHeaders) {
  // Rate limiting check
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  await checkRateLimit(env, clientIP);

  // Get request body
  const contentType = request.headers.get('Content-Type') || '';
  let htmlContent;

  if (contentType.includes('application/json')) {
    const body = await request.json();
    htmlContent = body.html || body.content;
  } else {
    htmlContent = await request.text();
  }

  // Preprocess content to remove multipart artifacts and clean formatting
  htmlContent = preprocessContent(htmlContent);

  if (!htmlContent || htmlContent.length === 0) {
    return new Response('No content provided', { 
      status: 400,
      headers: corsHeaders 
    });
  }

  // Validate content size (max 1MB)
  if (htmlContent.length > 1024 * 1024) {
    return new Response('Content too large (max 1MB)', { 
      status: 413,
      headers: corsHeaders 
    });
  }

  // Generate unique ID
  const id = await generateUniqueId(env);
  
  // Parse HTML content
  const parsedContent = await parseHtmlContent(htmlContent);
  
  // Create data structure
  const conversationData = {
    id: id,
    content: {
      parsed: parsedContent,
      raw: htmlContent,
      format: parsedContent?.format || 'raw',
      metadata: {
        created: new Date().toISOString(),
        size: htmlContent.length,
        ip: clientIP
      }
    }
  };

  // Save to KV
  await env.sharegpt.put(id, JSON.stringify(conversationData));

  // Return share URL
  const shareUrl = `${new URL(request.url).origin}/${id}`;
  
  return new Response(JSON.stringify({ 
    success: true, 
    id: id,
    url: shareUrl 
  }), {
    headers: { 
      ...corsHeaders, 
      'Content-Type': 'application/json' 
    }
  });
}

/**
 * Handle GET request to display conversation
 */
async function handleGet(id, env, corsHeaders, rawMode = false) {
  // Validate ID format
  if (!/^[a-zA-Z0-9]{8}$/.test(id)) {
    return new Response('Invalid conversation ID', { 
      status: 400,
      headers: corsHeaders 
    });
  }

  // Retrieve from KV
  const data = await env.sharegpt.get(id);
  if (!data) {
    return new Response('Conversation not found', { 
      status: 404,
      headers: corsHeaders 
    });
  }

  const conversationData = JSON.parse(data);
  
  // If rawMode is true or format is 'raw', return raw HTML directly
  if (rawMode || conversationData.content.format === 'raw') {
    return new Response(conversationData.content.raw, {
      headers: { 
        ...corsHeaders, 
       'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  }
  
  // Otherwise, generate formatted conversation HTML
  const html = generateConversationHtml(conversationData);

  return new Response(html, {
    headers: { 
      ...corsHeaders, 
     'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    }
  });
}

/**
 * Generate unique 8-character ID
 */
async function generateUniqueId(env) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    let id = '';
    for (let i = 0; i < 8; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }

    // Check if ID already exists
    const existing = await env.sharegpt.get(id);
    if (!existing) {
      return id;
    }
    attempts++;
  }

  throw new Error('Failed to generate unique ID');
}

/**
 * HTMLRewriter-based HTML Parser for Cloudflare Workers
 * Enhanced parsing for specific HTML structures
 */
class ElementHandler {
  constructor(cb, attr) {
    this._cb = cb;
    this._attr = attr;
  }

  element(e) {
    if (this._attr) {
      this._cb(e.getAttribute(this._attr));
    } else {
      this._cb();
    }
  }
}

class DocumentHandler {
  constructor(onEnd) {
    this._onEnd = onEnd;
    this._onText = () => { };
    this._buffer = "";
    this._doOnText = false;
  }

  end(end) {
    this._onEnd();
  }

  text(text) {
    if (this._doOnText) {
      this._buffer += text.text;
      if (text.lastInTextNode) {
        const result = this.decodeHtmlEntities(this._buffer);
        this._buffer = "";
        this._doOnText = false;
        this._onText(result);
      }
    }
  }

  set onText(cb) {
    this._doOnText = true;
    this._onText = cb;
  }

  // Simple HTML entity decoder
  decodeHtmlEntities(text) {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/');
  }
}

function TextHandlerFactory(cb, dh) {
  return new ElementHandler(() => {
    dh.onText = cb;
  });
}

/**
 * HTMLRewriter-based parser for enhanced HTML parsing
 */
async function parseWithHTMLRewriter(htmlContent, tracks) {
  return new Promise(async (resolve, reject) => {
    try {
      const result = {};
      const dh = new DocumentHandler(() => resolve(result));
      let rewriter = new HTMLRewriter();

      for (let [k, v] of Object.entries(tracks)) {
        if (!Array.isArray(v)) v = [v];
        const handler = (v.length > 1 && v[1])
          ? new ElementHandler(x => result[k] = x, v[1])
          : TextHandlerFactory(x => result[k] = x, dh);
        rewriter = rewriter.on(v[0], handler);
      }

      const response = new Response(htmlContent);
      const transformedResponse = rewriter.onDocument(dh).transform(response);
      await transformedResponse.text();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Check if content is valid conversation JSON format
 */
function isValidConversationJSON(content) {
  try {
    const data = JSON.parse(content);
    if (!Array.isArray(data) || data.length === 0) {
      return false;
    }
    
    // Check if all items have required fields
    return data.every(item => 
      item && 
      typeof item === 'object' && 
      typeof item.from === 'string' && 
      typeof item.value === 'string' &&
      (item.from === 'human' || item.from === 'gpt' || item.from === 'user' || item.from === 'assistant')
    );
  } catch (error) {
    return false;
  }
}

/**
 * Sanitize HTML content - Remove dangerous elements but preserve safe ones like tables
 */
function sanitizeHtmlContent(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    // Remove potentially dangerous scripts, styles, iframes, noscript
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    // Remove event handlers and javascript: URIs
    .replace(/\s+on\w+="[^"]*"/gi, '')
    .replace(/\s+on\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

/**
 * Parse JSON conversation format
 */
function parseJSONConversation(content) {
  try {
    const data = JSON.parse(content);
    const messages = data.map(item => ({
      role: (item.from === 'human' || item.from === 'user') ? 'user' : 'assistant',
      content: sanitizeHtmlContent(item.value) // Use sanitizeHtmlContent instead of cleanHtmlContent
    }));
    
    return {
      messages: messages,
      format: 'json',
      messageCount: messages.length
    };
  } catch (error) {
    console.error('JSON parsing error:', error);
    return {
      messages: [{
        role: 'unknown',
        content: cleanHtmlContent(content)
      }],
      format: 'fallback',
      error: error.message
    };
  }
}

/**
 * Parse HTML content to extract conversation data
 */
async function parseHtmlContent(html) {
  try {
    // First priority: Check for JSON conversation format
    if (isValidConversationJSON(html)) {
      console.log('Detected JSON conversation format');
      return parseJSONConversation(html);
    }

    // Second priority: HTMLRewriter-based parsing for ChatGPT format
    if (html.includes('data-message-author-role') || html.includes('message-content')) {
      try {
        const tracks = {
          userMessages: ['[data-message-author-role="user"]'],
          assistantMessages: ['[data-message-author-role="assistant"]'],
          messageTexts: ['.message-content', null],
          userTexts: ['[data-message-author-role="user"] .message-content', null],
          assistantTexts: ['[data-message-author-role="assistant"] .message-content', null]
        };
        
        const htmlRewriterResult = await parseWithHTMLRewriter(html, tracks);
        
        // Process HTMLRewriter results into message format
        if (htmlRewriterResult.userTexts || htmlRewriterResult.assistantTexts) {
          const messages = [];
          
          // Note: HTMLRewriter processes sequentially, so we get the last matching element
          // For a proper implementation, we'd need to track multiple messages
          if (htmlRewriterResult.userTexts) {
            messages.push({
              role: 'user',
              content: cleanHtmlContent(htmlRewriterResult.userTexts)
            });
          }
          if (htmlRewriterResult.assistantTexts) {
            messages.push({
              role: 'assistant', 
              content: cleanHtmlContent(htmlRewriterResult.assistantTexts)
            });
          }
          
          if (messages.length > 0) {
            return {
              messages: messages,
              format: 'htmlrewriter',
              messageCount: messages.length
            };
          }
        }
      } catch (htmlRewriterError) {
        console.log('HTMLRewriter parsing failed, falling back to regex:', htmlRewriterError);
      }
    }

    // Fallback to regex-based parsing
    const messages = [];
    
    // Look for common ChatGPT patterns
    const patterns = [
      // ChatGPT web interface
      /<div[^>]*data-message-author-role="(user|assistant)"[^>]*>([\s\S]*?)<\/div>/gi,
      // Alternative pattern for copied conversations
      /<div[^>]*class="[^"]*message[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
      // Simple pattern for pasted text
      /^(User|Human|Assistant|AI):\s*([\s\S]*?)(?=^(?:User|Human|Assistant|AI):|$)/gmi
    ];

    for (const pattern of patterns) {
      const matches = [...html.matchAll(pattern)];
      if (matches.length > 0) {
        for (const match of matches) {
          if (match[1] && match[2]) {
            messages.push({
              role: match[1].toLowerCase(),
              content: cleanHtmlContent(match[2])
            });
          } else if (match[1]) {
            // Handle simple text pattern
            const role = match[0].toLowerCase().includes('user') || match[0].toLowerCase().includes('human') ? 'user' : 'assistant';
            messages.push({
              role: role,
              content: cleanHtmlContent(match[1])
            });
          }
        }
        break;
      }
    }

    // If no structured messages found, treat as single message
    if (messages.length === 0) {
      messages.push({
        role: 'unknown',
        content: cleanHtmlContent(html)
      });
    }

    return {
      messages: messages,
      format: 'parsed',
      messageCount: messages.length
    };

  } catch (error) {
    console.error('Parse error:', error);
    return {
      messages: [{
        role: 'unknown',
        content: cleanHtmlContent(html)
      }],
      format: 'fallback',
      error: error.message
    };
  }
}

/**
 * Preprocess content to remove multipart form data artifacts
 */
function preprocessContent(content) {
  if (!content || typeof content !== 'string') {
    return '';
  }

  return content
    // Remove multipart boundaries and headers
    .replace(/^-{20,}\d{15,}-{0,2}$/gm, '')
    .replace(/^Content-Disposition:.*$/gm, '')
    .replace(/^Content-Type:.*$/gm, '')
    .replace(/^Content-Length:.*$/gm, '')
    .replace(/^boundary=.*$/gm, '')
    .replace(/^name=".*?"$/gm, '')
    
    // Remove empty lines created by boundary removal
    .replace(/^\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    
    .trim();
}

/**
 * Clean HTML content for display with enhanced formatting
 */
function cleanHtmlContent(content) {
  if (!content || typeof content !== 'string') {
    return '';
  }

  return content
    // Remove multipart form boundaries
    .replace(/^-{10,}\d{10,}-{0,2}$/gm, '')
    .replace(/^Content-.*?$/gm, '')
    .replace(/^boundary=.*?$/gm, '')
    
    // Remove HTML tags and scripts
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    
    // Convert common HTML elements to text equivalents
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    
    // Remove all remaining HTML tags
    .replace(/<[^>]*>/g, '')
    
    // Decode HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '...')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    
    // Clean up whitespace and formatting
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/\r/g, '\n')   // Convert remaining \r to \n
    .replace(/\n{3,}/g, '\n\n') // Limit consecutive newlines to 2
    .replace(/[ \t]+/g, ' ') // Replace multiple spaces/tabs with single space
    .replace(/^ +/gm, '')    // Remove leading spaces
    .replace(/ +$/gm, '')    // Remove trailing spaces
    
    // Remove empty lines at start and end, but preserve internal paragraph breaks
    .replace(/^\n+/, '')     // Remove leading newlines
    .replace(/\n+$/, '')     // Remove trailing newlines
    
    // Clean up special characters and artifacts
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // Remove zero-width spaces
    .replace(/[^\S\n]+/g, ' ') // Replace other whitespace with spaces
    
    .trim();
}

/**
 * Rate limiting check
 */
async function checkRateLimit(env, ip) {
  const key = `rate_limit:${ip}`;
  const current = await env.sharegpt.get(key);
  const limit = 10; // 10 requests per hour
  
  if (current && parseInt(current) >= limit) {
    throw new Error('Rate limit exceeded. Please try again later.');
  }
  
  const newCount = (parseInt(current) || 0) + 1;
  await env.sharegpt.put(key, String(newCount), { expirationTtl: 3600 });
}

/**
 * Generate HTML for displaying conversation
 */
function generateConversationHtml(conversationData) {
  const { parsed, metadata } = conversationData.content;
  const messages = parsed.messages || [];
  
  let messagesHtml = '';
  
  for (const message of messages) {
    const roleClass = message.role === 'user' ? 'user-message' : 'assistant-message';
    const roleLabel = message.role === 'user' ? 'User' : 'Assistant';
    
    messagesHtml += `
      <div class="message ${roleClass}">
        <div class="role-label">${roleLabel}</div>
        <div class="content">${sanitizeHtmlContent(message.content)}</div>
      </div>
    `;
  }

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Shared Conversation - ${conversationData.id}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
            background: #f5f5f5;
            padding: 20px;
        }
        
        .container {
            max-width: 60vw;
            margin: 0 auto;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        
        .header {
            background: #2563eb;
            color: white;
            padding: 20px;
            text-align: center;
        }
        
        .conversation {
            padding: 20px;
        }
        
        .message {
            margin-bottom: 20px;
            padding: 2vw;
            border-radius: 8px;
            border-left: 4px solid #ddd;
        }
        
        .user-message {
            background: #f0f9ff;
            border-left-color: #2563eb;
        }
        
        .assistant-message {
            background: #f9fafb;
            border-left-color: #10b981;
        }
        
        .role-label {
            font-weight: bold;
            margin-bottom: 8px;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .user-message .role-label {
            color: #2563eb;
        }
        
        .assistant-message .role-label {
            color: #10b981;
        }
        
        .content {
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        
        /* Table styling for proper display */
        .content table {
            width: 100%;
            border-collapse: collapse;
            margin: 12px 0;
        }
        
        .content th, .content td {
            border: 1px solid #e5e7eb;
            padding: 8px;
            text-align: left;
        }
        
        .content th {
            background: #f3f4f6;
            font-weight: 600;
        }
        
        /* Code block styling */
        .content pre {
            position: relative;
            background: #0d1117;
            border-radius: 6px;
            padding: 16px;
            margin: 16px 0;
            overflow-x: auto;
            max-height: 400px;
        }
        
        .content code {
            background: #f6f8fa;
            padding: 2px 4px;
            border-radius: 3px;
            font-size: 85%;
        }
        
        .content pre code {
            background: transparent;
            padding: 0;
            font-size: 14px;
            color: #e6edf3;
        }
        
        /* Copy button for code blocks */
        .code-copy-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            background: #21262d;
            color: #f0f6fc;
            border: 1px solid #30363d;
            padding: 6px 12px;
            font-size: 12px;
            border-radius: 4px;
            cursor: pointer;
            opacity: 0;
            transition: opacity .2s;
        }
        
        .content pre:hover .code-copy-btn {
            opacity: 1;
        }
        
        .code-copy-btn.copied {
            background: #16a34a;
            border-color: #16a34a;
        }
        
        /* Scrollbar styling */
        .content pre::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        
        .content pre::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.2);
            border-radius: 4px;
        }
        
        .content pre::-webkit-scrollbar-track {
            background: transparent;
        }
        
        .footer {
            background: #f9fafb;
            padding: 15px 20px;
            border-top: 1px solid #e5e7eb;
            font-size: 12px;
            color: #6b7280;
            text-align: center;
        }
        
        .share-info {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        
        .copy-btn {
            background: #2563eb;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        
        .copy-btn:hover {
            background: #1d4ed8;
        }
        
        @media (max-width: 768px) {
            body {
                padding: 10px;
            }
            
            .container {
                border-radius: 0;
                max-width: 90vw;
            }
            
            .share-info {
                flex-direction: column;
                gap: 10px;
            }
        }
    </style>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.8.0/build/styles/github-dark.min.css">
    <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.8.0/build/highlight.min.js"></script>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Shared Conversation</h1>
            <p>Conversation ID: ${conversationData.id}</p>
        </div>
        
        <div class="conversation">
            ${messagesHtml}
        </div>
        
        <div class="footer">
            <div class="share-info">
                <span>Created: ${new Date(metadata.created).toLocaleString()}</span>
                <button class="copy-btn" onclick="copyUrl()">Copy Share URL</button>
            </div>
            <div>
                ${messages.length} messages • ${Math.round(metadata.size / 1024)}KB
            </div>
        </div>
    </div>
    
    <script>
        function copyUrl() {
            navigator.clipboard.writeText(window.location.href).then(() => {
                const btn = document.querySelector('.copy-btn');
                const original = btn.textContent;
                btn.textContent = 'Copied!';
                setTimeout(() => btn.textContent = original, 2000);
            });
        }
        
        // Initialize highlight.js and add copy buttons
        document.addEventListener('DOMContentLoaded', function() {
            // Highlight all code blocks
            hljs.highlightAll();
            
            // Add copy buttons to all pre blocks
            document.querySelectorAll('pre').forEach(pre => {
                const btn = document.createElement('button');
                btn.className = 'code-copy-btn';
                btn.textContent = 'Copy';
                btn.addEventListener('click', () => {
                    const code = pre.innerText;
                    navigator.clipboard.writeText(code).then(() => {
                        btn.classList.add('copied');
                        btn.textContent = 'Copied!';
                        setTimeout(() => {
                            btn.classList.remove('copied');
                            btn.textContent = 'Copy';
                        }, 2000);
                    }).catch(err => {
                        console.error('Failed to copy: ', err);
                    });
                });
                pre.appendChild(btn);
            });
        });
    </script>
</body>
</html>
  `;
}

/**
 * Generate upload form HTML
 */
function getUploadForm() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ShareGPT - Share Your Conversations</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
            background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
            min-height: 100vh;
            padding: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .container {
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            width: 100%;
            max-width: 500px;
        }
        
        h1 {
            text-align: center;
            margin-bottom: 10px;
            color: #2563eb;
        }
        
        .subtitle {
            text-align: center;
            color: #6b7280;
            margin-bottom: 30px;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 500;
        }
        
        textarea {
            width: 100%;
            min-height: 200px;
            padding: 12px;
            border: 2px solid #e5e7eb;
            border-radius: 6px;
            font-family: inherit;
            font-size: 14px;
            resize: vertical;
        }
        
        textarea:focus {
            outline: none;
            border-color: #2563eb;
        }
        
        .submit-btn {
            width: 100%;
            background: #2563eb;
            color: white;
            border: none;
            padding: 12px;
            border-radius: 6px;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.2s;
        }
        
        .submit-btn:hover {
            background: #1d4ed8;
        }
        
        .submit-btn:disabled {
            background: #9ca3af;
            cursor: not-allowed;
        }
        
        .result {
            margin-top: 20px;
            padding: 15px;
            border-radius: 6px;
            display: none;
        }
        
        .result.success {
            background: #ecfdf5;
            border: 1px solid #10b981;
            color: #065f46;
        }
        
        .result.error {
            background: #fef2f2;
            border: 1px solid #ef4444;
            color: #991b1b;
        }
        
        .share-url {
            background: #f9fafb;
            padding: 10px;
            border-radius: 4px;
            margin-top: 10px;
            font-family: monospace;
            word-break: break-all;
        }
        
        .copy-btn {
            background: #10b981;
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            margin-top: 8px;
        }
        
        .instructions {
            background: #f0f9ff;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
            font-size: 14px;
        }
        
        .instructions h3 {
            margin-bottom: 8px;
            color: #2563eb;
        }
        
        .instructions ul {
            margin-left: 20px;
        }
        
        .instructions li {
            margin-bottom: 4px;
        }
        /* ===== 新增：highlight.js Dark Theme ===== */
        .hljs {
          display: block;
          overflow-x: auto;
          padding: 0.75rem;
          border-radius: 0.25rem;
          color: #cdd9e5;
          background: #000;
        }
        .hljs-comment,
        .hljs-punctuation {
          color: #768390;
        }
        .hljs-attr,
        .hljs-attribute,
        .hljs-meta,
        .hljs-selector-attr,
        .hljs-selector-class,
        .hljs-selector-id {
          color: #6cb6ff;
        }
        .hljs-variable,
        .hljs-literal,
        .hljs-number,
        .hljs-doctag {
          color: #f69d50;
        }
        .hljs-params { color: #cdd9e5; }
        .hljs-function { color: #dcbdfb; }
        .hljs-class,
        .hljs-tag,
        .hljs-title,
        .hljs-built_in { color: #8ddb8c; }
        .hljs-keyword,
        .hljs-type,
        .hljs-builtin-name,
        .hljs-meta-keyword,
        .hljs-template-tag,
        .hljs-template-variable { color: #f47067; }
        .hljs-string,
        .hljs-undefined,
        .hljs-regexp { color: #96d0ff; }
        .hljs-symbol { color: #6cb6ff; }
        .hljs-bullet { color: #f69d50; }
        .hljs-section { color: #6cb6ff; font-weight: bold; }
        .hljs-quote,
        .hljs-name,
        .hljs-selector-tag,
        .hljs-selector-pseudo { color: #8ddb8c; }
        .hljs-emphasis { color: #f69d50; font-style: italic; }
        .hljs-strong { color: #f69d50; font-weight: bold; }
        .hljs-deletion { color: #ff938a; background-color: #78191b; }
        .hljs-addition { color: #8ddb8c; background-color: #113417; }
        .hljs-link { color: #96d0ff; font-style: underline; }
            /* 額外：讓 <pre> 區塊拉滿寬、橫向捲動時隱藏底部捲軸 */
    pre {
      max-height: 400px;
      margin: 1rem 0;
      overflow: auto;
      margin: 1rem 0;            /* Firefox */
    }
        /* 捲軸美化（可省略） */
        pre::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        pre::-webkit-scrollbar-thumb {
            background: rgba(0,0,0,0.3);
            border-radius: 4px;
        }
        pre::-webkit-scrollbar-track {
            background: transparent;
        }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/highlight.js@11.8.0/build/common.min.js"></script>
</head>
<body>
    <div class="container">
        <h1>ShareGPT</h1>
        <p class="subtitle">Share your AI conversations easily</p>
        
        <div class="instructions">
            <h3>How to use:</h3>
            <ul>
                <li>Copy and paste your chat conversation HTML</li>
                <li>Or paste the raw conversation text</li>
                <li>Click "Share Conversation" to get a shareable link</li>
                <li>Share the link with others to show your conversation</li>
            </ul>
        </div>
        
        <form id="shareForm">
            <div class="form-group">
                <label for="content">Conversation Content:</label>
                <textarea 
                    id="content" 
                    name="content" 
                    placeholder="Paste your conversation HTML or text here..."
                    required
                ></textarea>
            </div>
            
            <button type="submit" class="submit-btn">Share Conversation</button>
        </form>
        
        <div id="result" class="result"></div>
    </div>
    
    <script>
        document.getElementById('shareForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const content = document.getElementById('content').value;
            const submitBtn = document.querySelector('.submit-btn');
            const result = document.getElementById('result');
            
            if (!content.trim()) {
                showResult('Please enter some content to share.', 'error');
                return;
            }
            
            // Show loading state
            submitBtn.disabled = true;
            submitBtn.textContent = 'Creating share link...';
            result.style.display = 'none';
            
            try {
                const response = await fetch('/', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ html: content })
                });
                
                if (!response.ok) {
                    throw new Error(await response.text());
                }
                
                const data = await response.json();
                
                if (data.success) {
                    showResult(
                        'Conversation shared successfully!' +
                        '<div class="share-url">' + data.url + '</div>' +
                        '<button class="copy-btn" onclick="copyToClipboard(\'' + data.url + '\')">Copy Link</button>',
                        'success'
                    );
                    document.getElementById('content').value = '';
                } else {
                    throw new Error('Failed to create share link');
                }
                
            } catch (error) {
                showResult('Error: ' + error.message, 'error');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Share Conversation';
            }
        });
        
        function showResult(message, type) {
            const result = document.getElementById('result');
            result.innerHTML = message;
            result.className = 'result ' + type;
            result.style.display = 'block';
        }
        
        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                const btn = event.target;
                const original = btn.textContent;
                btn.textContent = 'Copied!';
                setTimeout(() => btn.textContent = original, 2000);
            });
        }
    </script>
      <!-- ===== 啟動 highlight.js ===== -->
  <script>
    document.querySelectorAll('code.hljs').forEach(el => hljs.highlightElement(el));
  </script>
</body>
</html>
  `;
}
