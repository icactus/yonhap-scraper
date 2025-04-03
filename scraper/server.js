require('dotenv').config();
const fs = require('fs');
const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require('node-fetch');
const xml2js = require('xml2js');

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Set up public directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// Main route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// API endpoint
app.get('/api/articles', async (req, res) => {
  try {
    const results = await processArticles();
    res.json({ articles: results });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: 'Failed to process articles',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// New export endpoint
app.get('/export', async (req, res) => {
  try {
    const articles = await processArticles();
    await exportStaticFiles(articles);
    res.send('Static files generated in /public');
  } catch (error) {
    console.error('Export failed:', error);
    res.status(500).send('Export failed');
  }
});

// Core processing function
async function processArticles(limit = 2) {
  console.time('Article processing');
  
  console.log('Fetching RSS feed...');
  const articleLinks = await getArticleLinksFromRSS();
  console.log(`Found ${articleLinks.length} article links`);

  console.log('Scraping article content...');
  const rawArticles = await scrapeArticlePages(articleLinks.slice(0, limit));
  console.log(`Extracted ${rawArticles.length} articles`);

  const combinedText = rawArticles.map(a => `Title: ${a.title}\n${a.content}`).join('\n\n---\n\n');
  
  console.log('Processing with Gemini...');
  let processedArticles;
  try {
    processedArticles = await translateAndSummarize(combinedText);
  } catch (geminiError) {
    console.error('Gemini processing failed, using fallback:', geminiError);
    processedArticles = rawArticles.map(article => ({
      translatedTitle: article.title,
      summary: {
        quote: '',
        text: 'Summary generation failed',
        interestLevel: '⭐️'
      }
    }));
  }

  const results = rawArticles.map((rawArticle, index) => ({
    originalTitle: rawArticle.title,
    translatedTitle: processedArticles[index]?.translatedTitle || rawArticle.title,
    summary: processedArticles[index]?.summary || {
      quote: '',
      text: 'Summary not available',
      interestLevel: '⭐️'
    },
    url: rawArticle.url,
    date: rawArticle.date
  }));

  console.timeEnd('Article processing');
  return results;
}

// RSS feed parser
async function getArticleLinksFromRSS() {
  const response = await fetch('https://www.yna.co.kr/rss/northkorea.xml');
  const xmlText = await response.text();
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(xmlText);
  
  const items = result.rss.channel.item;
  return items.map(item => ({
    url: item.link,
    date: item.pubDate,
    title: item.title
  }));
}

// Article scraper
async function scrapeArticlePages(articleLinks) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    });

    const articles = [];
    const page = await browser.newPage();

    for (const link of articleLinks) {
      try {
        console.log(`Visiting: ${link.url}`);
        await page.goto(link.url, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });

        await page.waitForSelector('.story-news', { timeout: 30000 });

        const articleData = await page.evaluate(() => {
          const title = document.querySelector('h1.tit')?.textContent.trim() || 'No title from page';
          const storyNews = document.querySelector('.story-news');
          const content = storyNews ? Array.from(storyNews.querySelectorAll('p'))
            .map(p => p.textContent.trim())
            .filter(text => text && 
              !text.startsWith('(연합뉴스)') && 
              !text.startsWith('http') && 
              !text.includes('@yna.co.kr') && 
              !text.includes('무단 전재-재배포') && 
              !text.match(/^\d{4}\/\d{2}\/\d{2}/) && 
              !text.includes('KakaoTalk okjebo'))
            .join('\n') : 'No content available';
          
          return { title, content };
        });

        articles.push({
          title: articleData.title !== 'No title from page' ? articleData.title : link.title,
          content: articleData.content,
          url: link.url,
          date: link.date
        });
      } catch (error) {
        console.error(`Failed to scrape ${link.url}: ${error.message}`);
        articles.push({
          title: link.title,
          content: `Failed to load content from ${link.url}: ${error.message}`,
          url: link.url,
          date: link.date
        });
      }
    }

    return articles;
  } finally {
    if (browser) await browser.close();
  }
}

// Gemini processor
async function translateAndSummarize(text) {
  if (!text) return [];

  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  const prompt = `
  For the following text, which contains multiple articles separated by "---":
  1. For each article:
     - Translate the title from Korean to English
     - Create a summary with:
       * A direct quote (translated to English)
       * 3-4 sentence summary
       * Interest level rating (1-5 stars) that would be expected of a professor of modern korean history. 

  Return ONLY a JSON array with this exact structure:
  [
    {
      "translatedTitle": "English title here",
      "summary": {
        "quote": "most interesting translated quote", //no quotation marks
        "text": "3-4 sentence summary text",
        "interestLevel": "⭐️⭐️⭐️⭐️" // 1-5 stars 1 being low interest for a professor of modern korean history, particularly cold war history and leftist movements including north korea and the intersection with women and gender studies, 5 being highest when compared to all the articles on NK in a given week that she could encounter.
      }
    },
    ...
  ]

  IMPORTANT:
  - This is to be read by an important Modern Korean Historian. As their very overqualified assistant committed to the work, make sure your summaries are tailored to her work so that you don't miss anything she would find of interesting note or value in the summary.
  - Only return the JSON array, nothing else
  - Do not use quotation marks around the quote.
  - No markdown code blocks
  - No explanatory text
  - No trailing commas
  - Maintain proper JSON syntax

Text:
  ${text}
  `;

  try {
    const result = await model.generateContent(prompt);
    const responseText = (await result.response).text();
    
    // Extract JSON from response
    const jsonStart = responseText.indexOf('[');
    const jsonEnd = responseText.lastIndexOf(']') + 1;
    if (jsonStart === -1 || jsonEnd === 0) throw new Error('No valid JSON found');
    
    const jsonString = responseText.slice(jsonStart, jsonEnd);
    return JSON.parse(jsonString);
  } catch (error) {
    console.error('Gemini processing failed:', error);
    throw error;
  }
}

// Static file generator
async function exportStaticFiles(articles) {
  const publicDir = path.join(__dirname, '..', 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
  
  // Save JSON data
  fs.writeFileSync(
    path.join(publicDir, 'articles.json'),
    JSON.stringify({ articles }, null, 2)
  );

  // Generate HTML
  const html = `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>North Korea News Digest</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        max-width: 800px;
        margin: 0 auto;
        padding: 20px;
        line-height: 1.6;
      }
      .article {
        margin-bottom: 30px;
        padding: 20px;
        border: 1px solid #e0e0e0;
        border-radius: 5px;
        background: #f9f9f9;
      }
      .quote {
        font-style: italic;
        color: #2a6496;
        margin: 10px 0;
        padding-left: 10px;
        border-left: 3px solid #4caf50;
      }
      .interest-level {
        color: #ff9800;
        font-size: 1.1em;
        margin: 10px 0;
      }
      .meta {
        display: flex;
        justify-content: space-between;
        color: #666;
        font-size: 0.9em;
        margin-top: 15px;
      }
    </style>
  </head>
  <body>
    <h1>North Korea News Digest</h1>
    <p>Last updated: ${new Date().toLocaleString()}</p>
    
    ${articles.map(article => `
      <div class="article">
        <h2>${article.translatedTitle}</h2>
        <div class="meta">
          <span>${new Date(article.date).toLocaleDateString()}</span>
          <a href="${article.url}" target="_blank">Original Article</a>
        </div>
        ${article.summary.quote ? `<div class="quote">${article.summary.quote}</div>` : ''}
        <div class="summary">${article.summary.text}</div>
        <div class="interest-level">Interest Level: ${article.summary.interestLevel}</div>
      </div>
    `).join('')}
  </body>
  </html>`;

  fs.writeFileSync(path.join(publicDir, 'index.html'), html);
}

if (process.argv.includes('--export')) {
  (async () => {
    try {
      const articles = await processArticles();
      await exportStaticFiles(articles);
      console.log('Static files generated in /public');
      process.exit(0);
    } catch (error) {
      console.error('Export failed:', error);
      process.exit(1);
    }
  })();
} else {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Access /export to generate static files`);
  });
}
