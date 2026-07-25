import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { Feed } from 'feed';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { glob } from 'glob';

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the output directory (where GitHub Pages will serve from)
const outputDir = path.join(__dirname, 'dist');

// Path to the artists directory
const artistsDir = path.join(__dirname, 'artists');

// Ensure the output directory exists
fs.ensureDirSync(outputDir);

// Ensure the artists directory exists
fs.ensureDirSync(artistsDir);

/**
 * Scrape releases from an artist page
 * @param {Object} artist - Artist object with name, url, and optionally maxReleases
 * @returns {Promise<Array>} - Array of release objects
 */
async function scrapeArtistReleases(artist) {
  const { url } = artist;
  // Get the maximum number of releases to scrape from artist object or use default
  const maxReleases = artist.maxReleases || 2; // Default to 2 if not specified
  
  // Determine which scraper to use based on the URL
  if (url.includes('bandcamp.com')) {
    return scrapeBandcamp(url, maxReleases, artist.includeUpcoming || false);
  } else if (url.includes('soundcloud.com')) {
    return scrapeSoundcloud(url, maxReleases);
  } else if (url.includes('spotify.com')) {
    return scrapeSpotify(url, maxReleases);
  } else {
    // For demo purposes, return a sample release
    return [{
      title: "Sample Release",
      url: "https://example.com/sample-release",
      date: new Date(),
      image: "",
      description: `Demo release for ${artist.name}`
    }];
  }
}

/**
 * Scrape releases from a Bandcamp artist page
 * @param {string} url - Bandcamp artist URL
 * @param {number} maxReleases - Maximum number of releases to scrape (from artist config)
 * @returns {Promise<Array>} - Array of release objects
 */
async function scrapeBandcamp(url, maxReleases = 2, includeUpcoming = false) {
  try {
    // First fetch the artist page to get all album links
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    const releases = [];

    // Get album/track items from the page
    const albumItems = $('.music-grid-item');
    
    console.log(`Found ${albumItems.length} potential releases, targeting ${maxReleases} valid releases`);
    
    // Process albums until we reach maxReleases valid (non-future) releases
    // or until we've gone through all available albums
    let validReleasesCount = 0;
    let i = 0;
    
    while (validReleasesCount < maxReleases && i < albumItems.length) {
      const el = albumItems[i];
      i++; // Increment the counter before any continues
      
      const albumUrl = $(el).find('a').attr('href');
      const title = $(el).find('.title').text().trim();
      const imageUrl = $(el).find('img').attr('src') || '';
      const artistOverride = $(el).find('.artist-override').text().trim();
      
      // Make sure the URL is absolute
      const fullAlbumUrl = albumUrl.startsWith('http') ? albumUrl : 
                         (albumUrl.startsWith('/') ? new URL(albumUrl, url).toString() : `${url}${albumUrl}`);
      
      try {
        // Fetch the album page to get detailed info
        console.log(`Fetching album details from: ${fullAlbumUrl}`);
        const { data: albumData } = await axios.get(fullAlbumUrl);
        const albumPage = cheerio.load(albumData);
        
        // Look for the release date in the album metadata
        let releaseDate;
        
        // Try to find the release date in the tralbum data (embedded JSON)
        const scriptTags = albumPage('script[type="application/ld+json"]');
        let foundDate = false;
        
        scriptTags.each((_, script) => {
          if (foundDate) return;
          
          try {
            const jsonData = JSON.parse(albumPage(script).html());
            if (jsonData && jsonData.datePublished) {
              releaseDate = new Date(jsonData.datePublished);
              foundDate = true;
            }
          } catch (e) {
            // Continue if this script tag doesn't contain valid JSON
          }
        });
        
        // If we couldn't find date in JSON, look for it in the page content
        if (!foundDate) {
          // Look for the release date in the album credits section
          const creditsElement = albumPage('.tralbumData.tralbum-credits');
          if (creditsElement.length) {
            const creditsText = creditsElement.text();
            console.log(`Credits text found: "${creditsText}"`);
            
            // Look specifically for "released Month Day, Year" format
            const releaseDateMatch = creditsText.match(/released\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
            
            if (releaseDateMatch && releaseDateMatch[1]) {
              console.log(`Release date match found: "${releaseDateMatch[1]}"`);
              releaseDate = new Date(releaseDateMatch[1]);
              console.log(`Parsed date: ${releaseDate.toISOString()}`);
              foundDate = true;
            }
          }
          
          // If still not found, try other selectors
          if (!foundDate) {
            // Try another common format
            const altDateElement = albumPage('.tralbumData.tralbum-about-release-date');
            if (altDateElement.length) {
              const altDateMatch = altDateElement.text().trim();
              if (altDateMatch) {
                releaseDate = new Date(altDateMatch);
                foundDate = true;
              }
            }
          }
        }
        
        // If still no date found, try another selector specific to Bandcamp
        if (!foundDate || !releaseDate || isNaN(releaseDate.getTime())) {
          // Try meta tag
          const dateElement = albumPage('meta[itemprop="datePublished"]');
          if (dateElement.length) {
            const dateContent = dateElement.attr('content');
            if (dateContent) {
              console.log(`Found date in meta tag: ${dateContent}`);
              releaseDate = new Date(dateContent);
              foundDate = true;
            }
          }
          
          // As a last resort, try to find any text containing "released" followed by a date-like string
          if (!foundDate) {
            // Look through the entire page for any text containing "released" pattern
            const pageText = albumPage('body').text();
            const allReleasedMatches = pageText.match(/released\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/gi);
            
            if (allReleasedMatches && allReleasedMatches.length > 0) {
              // Use the first match
              const dateText = allReleasedMatches[0].replace(/released\s+/i, '');
              console.log(`Found release date in page text: ${dateText}`);
              releaseDate = new Date(dateText);
              foundDate = true;
            }
          }
        }

        // Check for "Album will be released on..." text patterns indicating future releases
        const preOrderText = albumPage('body').text().match(/will be released on|releases on|available on|releases \w+ \d{1,2},? \d{4}/i);
        const isPreOrder = !!preOrderText;
        if (isPreOrder) {
          console.log(`Found pre-order indication: "${preOrderText[0]}"`);
        }
        
        // Set description (might include album notes if available)
        let description = `New release by ${artistOverride || 'artist'}`;
        const albumNotes = albumPage('.tralbum-about').text().trim();
        if (albumNotes) {
          description = albumNotes.length > 300 ? 
                      albumNotes.substring(0, 297) + '...' : 
                      albumNotes;
        }
        
        // If we still don't have a date, use current date as fallback
        if (!releaseDate || isNaN(releaseDate.getTime())) {
          console.log(`Couldn't find release date for: ${title}. Using current date.`);
          releaseDate = new Date();
        }
        
        // Check if the release date is in the future
        const now = new Date();
        const isFutureRelease = releaseDate > now;
        
        if (isFutureRelease && !includeUpcoming) {
          console.log(`Skipping future release: ${title} (Release date: ${releaseDate.toISOString()})`);
          continue; // Skip this release and move to the next one without incrementing validReleasesCount
        }

        if (isFutureRelease && includeUpcoming) {
          description = `[Upcoming / Pre-order] ${description}`;
        }
        
        // If we got here, it's not a future release, so add it
        releases.push({
          title,
          url: fullAlbumUrl,
          date: releaseDate,
          image: imageUrl,
          description
        });
        
        // Increment the count of valid releases we've added
        validReleasesCount++;
        
      } catch (albumError) {
        console.error(`Error fetching album details for ${title}: ${albumError.message}`);
        // Add with basic info and current date if album page fetch fails
        releases.push({
          title,
          url: fullAlbumUrl,
          date: new Date(),
          image: imageUrl,
          description: `New release by ${artistOverride || 'artist'}`
        });
        
        // We still count this as a valid release even though it had an error
        validReleasesCount++;
      }
      
      // Add a small delay to avoid overloading the server
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    
    console.log(`Finished processing. Got ${releases.length} valid releases out of ${i} checked albums.`);

    // Sort the releases by date, newest first
    releases.sort((a, b) => b.date - a.date);

    return releases.length > 0 ? releases : [{
      title: "Sample Bandcamp Release",
      url: url,
      date: new Date(),
      image: "",
      description: "Demo release (no actual releases found)"
    }];
  } catch (error) {
    console.error(`Error scraping Bandcamp: ${error.message}`);
    return [{
      title: "Error Reading Bandcamp",
      url: url,
      date: new Date(),
      description: "Could not retrieve releases"
    }];
  }
}

/**
 * Scrape releases from a SoundCloud artist page
 * @param {string} url - SoundCloud artist URL
 * @param {number} maxReleases - Maximum number of releases to scrape
 * @returns {Promise<Array>} - Array of release objects
 */
async function scrapeSoundcloud(url, maxReleases = 2) {
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    const releases = [];

    // SoundCloud-specific selectors for releases
    const soundItems = $('.soundList__item');
    console.log(`Found ${soundItems.length} SoundCloud items, processing up to ${maxReleases}`);
    
    let count = 0;
    soundItems.each((i, el) => {
      // Stop if we've reached the maximum
      if (count >= maxReleases) return false;
      
      const title = $(el).find('.soundTitle__title').text().trim();
      const releaseUrl = $(el).find('.soundTitle__title').attr('href');
      const imageUrl = $(el).find('.image__full').attr('src') || '';
      const dateText = $(el).find('.soundTitle__uploadTime').text().trim();
      
      // Parse date or use current date if not found
      let date;
      try {
        if (dateText) {
          date = new Date(dateText);
        } else {
          date = new Date();
        }
      } catch (e) {
        date = new Date();
      }

      if (title && releaseUrl) {
        releases.push({
          title,
          url: releaseUrl.startsWith('http') ? releaseUrl : `https://soundcloud.com${releaseUrl}`,
          date,
          image: imageUrl,
          description: `New track on SoundCloud`
        });
        count++;
      }
    });

    return releases.length > 0 ? releases : [{
      title: "Sample SoundCloud Release",
      url: url,
      date: new Date(),
      image: "",
      description: "Demo release (no actual releases found)"
    }];
  } catch (error) {
    console.error(`Error scraping SoundCloud: ${error.message}`);
    return [{
      title: "Error Reading SoundCloud",
      url: url,
      date: new Date(),
      description: "Could not retrieve releases"
    }];
  }
}

/**
 * Scrape releases from a Spotify artist page
 * @param {string} url - Spotify artist URL
 * @param {number} maxReleases - Maximum number of releases to scrape
 * @returns {Promise<Array>} - Array of release objects
 */
async function scrapeSpotify(url, maxReleases = 2) {
  console.log(`Spotify scraping requested with maxReleases: ${maxReleases}`);
  // For demo purposes, return a sample release
  return [{
    title: "Sample Spotify Release",
    url: url,
    date: new Date(),
    image: "",
    description: "Demo release (Spotify requires authentication)"
  }];
}

/**
 * Processes all artist JSON files in the artists directory
 * @returns {Promise<void>}
 */
async function processArtistFiles() {
  try {
    // Find all .json files in the artists directory and its subdirectories
    const jsonFiles = glob.sync('**/*.json', { cwd: artistsDir });
    
    if (jsonFiles.length === 0) {
      console.log('No artist JSON files found. Creating a default one...');
      
      // Create a default file if none exist
      const defaultArtistsFile = path.join(artistsDir, 'default.json');
      const defaultArtists = {
        title: "Default Artist Feed",
        description: "Default feed for artists",
        artists: [
          {
            name: "Example Artist",
            url: "https://example.com/artist/page"
          }
        ]
      };
      
      await fs.writeJson(defaultArtistsFile, defaultArtists, { spaces: 2 });
      console.log(`Created default artists file at: ${defaultArtistsFile}`);
      jsonFiles.push('default.json');
    }
    
    console.log(`Found ${jsonFiles.length} artist JSON file(s) to process`);
    
    // Process each JSON file and generate a feed for it
    for (const jsonFile of jsonFiles) {
      const fullPath = path.join(artistsDir, jsonFile);
      console.log(`Processing artist file: ${fullPath}`);
      
      try {
        await generateFeedForFile(jsonFile, fullPath);
      } catch (error) {
        console.error(`Error processing ${jsonFile}: ${error.message}`);
      }
    }
    
    // Create an index page that links to all feeds
    await createIndexPage(jsonFiles);
    
  } catch (error) {
    console.error('Error processing artist files:', error);
  }
}

/**
 * Create an HTML page for a specific feed
 */
async function createFeedInfoPage(jsonFile, feedId, feedTitle, feedDirectory, releaseCount) {
  // Ensure the output directory exists
  const outputFeedDir = path.join(outputDir, feedDirectory);
  fs.ensureDirSync(outputFeedDir);
  
  const htmlPath = path.join(outputFeedDir, `${feedId}.html`);
  
  // Link directly to the bandcamp-rss repository
  let backLink = "/bandcamp-rss/";
  
  // Create a simple HTML page for this feed
  const feedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${feedTitle} - RSS Feed</title>
  <style>
    :root {
      --bg-color: #121212;
      --text-color: #e4e4e4;
      --link-color: #90caf9;
      --secondary-bg: #1e1e1e;
      --accent-color: #bb86fc;
      --border-color: #333333;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      background-color: var(--bg-color);
      color: var(--text-color);
    }
    .container {
      margin-top: 40px;
    }
    h1, h2, h3 {
      color: var(--accent-color);
    }
    .feed-link {
      background-color: var(--secondary-bg);
      padding: 15px;
      border-radius: 5px;
      font-family: monospace;
      word-break: break-all;
      border: 1px solid var(--border-color);
    }
    .feed-link a {
      color: var(--link-color);
      text-decoration: none;
    }
    .feed-link a:hover {
      text-decoration: underline;
    }
    pre {
      background-color: var(--secondary-bg);
      border-radius: 6px;
      padding: 16px;
      overflow: auto;
      border: 1px solid var(--border-color);
    }
    .back-link {
      margin-bottom: 20px;
    }
    .back-link a {
      color: var(--link-color);
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="back-link">
      <a href="${backLink}">← Back to All Feeds</a>
    </div>
    
    <h1>${feedTitle}</h1>
    <p>This feed contains releases from the artists configured in <code>${jsonFile}</code>.</p>
    
    <h2>Subscribe to this RSS Feed</h2>
    <div class="feed-link">
      <a href="./${feedId}-feed.xml">${feedId}-feed.xml</a>
    </div>
    
    <h3>Details</h3>
    <p>Feed ID: ${feedId}</p>
    <p>Number of releases: ${releaseCount}</p>
    <p>Last updated: ${
      (() => {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
      })()
    }</p>
    
    <footer>
      <p>Generated by <a href="https://github.com/blstrManx/bandcamp-rss">Bandcamp RSS Feed Generator</a></p>
    </footer>
  </div>
</body>
</html>`;
  
  await fs.writeFile(htmlPath, feedHtml);
  console.log(`Feed info page written to ${htmlPath}`);
}

/**
 * Create the main index page that links to all available feeds
 */
async function createIndexPage(jsonFiles) {
  // Prepare feed list
  let feedListHtml = '';
  
  for (const jsonFile of jsonFiles) {
    const feedId = path.basename(jsonFile, '.json');
    const feedDirectory = path.dirname(jsonFile);
    
    // Build proper paths for GitHub Pages
    // This is a key fix - we need to ensure web paths use forward slashes
    const relativePath = feedDirectory === '.' ? 
                       feedId : 
                       `${feedDirectory.replace(/\\/g, '/')}/${feedId}`;
    
    // Try to read the JSON to get the title
    try {
      const fullPath = path.join(artistsDir, jsonFile);
      const artistsData = await fs.readJson(fullPath);
      const feedTitle = artistsData.title || `${feedId} RSS Feed`;
      
      // Count releases by checking the corresponding feed XML
      let releaseCount = 0;
      const feedXmlPath = path.join(outputDir, feedDirectory, `${feedId}-feed.xml`);
      
      if (await fs.pathExists(feedXmlPath)) {
        const feedContent = await fs.readFile(feedXmlPath, 'utf8');
        releaseCount = (feedContent.match(/<item>/g) || []).length;
      }
      
      // Create individual feed HTML page
      await createFeedInfoPage(jsonFile, feedId, feedTitle, feedDirectory, releaseCount);
      
      feedListHtml += `
      <li class="feed-item">
        <a href="${relativePath}.html">${feedTitle}</a>
        <div class="feed-details">
          <span class="feed-id">${feedId}</span>
          <a href="${relativePath}-feed.xml" class="direct-link">Direct XML Link</a>
        </div>
      </li>`;
    } catch (error) {
      console.error(`Error reading feed info for ${jsonFile}:`, error);
      feedListHtml += `
      <li class="feed-item">
        <a href="${relativePath}.html">${feedId}</a>
        <div class="feed-details">
          <span class="feed-id">${feedId}</span>
          <a href="${relativePath}-feed.xml" class="direct-link">Direct XML Link</a>
        </div>
      </li>`;
    }
  }
  
  // Create the index HTML
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Artist RSS Feed Generator</title>
  <style>
    :root {
      --bg-color: #121212;
      --text-color: #e4e4e4;
      --link-color: #90caf9;
      --secondary-bg: #1e1e1e;
      --accent-color: #bb86fc;
      --border-color: #333333;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      background-color: var(--bg-color);
      color: var(--text-color);
    }
    .container {
      margin-top: 40px;
    }
    h1, h2, h3 {
      color: var(--accent-color);
    }
    a {
      color: var(--link-color);
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    .feed-list {
      list-style: none;
      padding: 0;
    }
    .feed-item {
      background-color: var(--secondary-bg);
      margin-bottom: 15px;
      padding: 15px;
      border-radius: 5px;
      border: 1px solid var(--border-color);
    }
    .feed-item a {
      font-size: 1.2em;
      font-weight: bold;
    }
    .feed-details {
      margin-top: 8px;
      font-size: 0.9em;
      color: #aaa;
      display: flex;
      justify-content: space-between;
    }
    .direct-link {
      font-family: monospace;
    }
    pre {
      background-color: var(--secondary-bg);
      border-radius: 6px;
      padding: 16px;
      overflow: auto;
      border: 1px solid var(--border-color);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Artist RSS Feed Generator</h1>
    <p>This page hosts automatically generated RSS feeds for the latest releases from your favorite artists.</p>
    
    <h2>Available Feeds</h2>
    <ul class="feed-list">
      ${feedListHtml}
    </ul>
    
    <h3>How to Use</h3>
    <p>Click on a feed to view details, or copy the direct XML link to add it to your favorite RSS reader.</p>
    
    <h3>Creating Custom Feeds</h3>
    <p>To create a new feed, add a JSON file to the 'artists' directory with the following format:</p>
    <pre>{
  "title": "Your Feed Title",
  "description": "Description of your feed",
  "artists": [
    {
      "name": "Artist Name",
      "url": "https://artist-bandcamp-url.com",
      "maxReleases": 5
    },
    {
      "name": "Another Artist",
      "url": "https://another-artist.bandcamp.com",
      "maxReleases": 3
    }
  ]
}</pre>
    
    <p>Last updated: ${
      (() => {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
      })()
    }</p>
    
    <footer>
      <p>Generated by <a href="https://github.com/blstrManx/bandcamp-rss">Bandcamp RSS Feed Generator</a></p>
    </footer>
  </div>
</body>
</html>`;
  
  await fs.writeFile(path.join(outputDir, 'index.html'), indexHtml);
  console.log(`Main index page written to ${path.join(outputDir, 'index.html')}`);
}

/**
 * Process and sanitize image URLs to ensure they are valid absolute URLs
 * @param {string} imageUrl - The original image URL
 * @param {string} baseUrl - The base URL to use for relative paths
 * @returns {string} - A valid absolute URL or empty string if invalid
 */
function processImageUrl(imageUrl, baseUrl) {
  if (!imageUrl || imageUrl.trim() === '') {
    return ''; // Return empty string for empty URLs
  }
  
  try {
    // Check if it's a relative URL
    if (imageUrl.startsWith('/')) {
      // Try to construct a full URL using the base URL
      const urlObj = new URL(baseUrl);
      return `${urlObj.protocol}//${urlObj.hostname}${imageUrl}`;
    } else if (!imageUrl.includes('://')) {
      // It's a relative URL without a leading slash
      const urlObj = new URL(baseUrl);
      return `${urlObj.protocol}//${urlObj.hostname}/${imageUrl}`;
    } else {
      // It's already an absolute URL, just return it
      return imageUrl;
    }
  } catch (error) {
    console.error(`Error processing image URL ${imageUrl}: ${error.message}`);
    return ''; // Return empty string if URL is invalid
  }
}

/**
 * Generates a feed for a specific artist JSON file - with URL validation fix
 * @param {string} jsonFile - Relative path to the JSON file within the artists directory
 * @param {string} fullPath - Full path to the JSON file
 * @returns {Promise<void>}
 */
async function generateFeedForFile(jsonFile, fullPath) {
  try {
    // Determine the output file name based on the JSON file path
    const feedId = path.basename(jsonFile, '.json');
    const feedDirectory = path.dirname(jsonFile);
    const outputFeedDir = path.join(outputDir, feedDirectory);
    
    // Ensure the output directory structure exists
    fs.ensureDirSync(outputFeedDir);
    
    // Load the artist file
    const artistsData = await fs.readJson(fullPath);
    
    // Get feed metadata or use defaults
    const feedTitle = artistsData.title || `${feedId} RSS Feed`;
    const feedDescription = artistsData.description || `Latest releases from ${feedId}`;
    const artists = artistsData.artists || [];
    
    if (artists.length === 0) {
      console.log(`No artists found in ${jsonFile}, skipping`);
      return;
    }
    
    // Create a new feed
    const feed = new Feed({
      title: feedTitle,
      description: feedDescription,
      id: `https://github.com/user/artist-rss-feed-generator/${feedId}`,
      link: `https://github.com/user/artist-rss-feed-generator/${feedId}`,
      language: "en",
      copyright: `All rights reserved ${new Date().getFullYear()}`,
      updated: new Date(),
      generator: "Artist RSS Feed Generator"
    });
    
    // Process each artist and add their releases to the feed
    console.log(`Processing ${artists.length} artists in ${jsonFile}...`);
    
    let totalReleaseCount = 0;
    
    for (const artist of artists) {
      console.log(`Scraping releases for: ${artist.name}`);
      
      try {
        const releases = await scrapeArtistReleases(artist);
        
        // Filter out sample/example releases
        const realReleases = releases.filter(release => {
          if (
            release.title.includes("Sample") || 
            release.title.includes("Error Reading") || 
            release.title.includes("Example") || 
            release.title.includes("Demo")
          ) {
            console.log(`Filtering out sample release: ${release.title}`);
            return false;
          }
          
          if (
            release.url.includes("example.com") || 
            !release.url.includes(".")
          ) {
            console.log(`Filtering out release with example URL: ${release.url}`);
            return false;
          }
          
          return true;
        });
        
        // Add each real release to the feed
        for (const release of realReleases) {
          // Process and validate the image URL
          let processedImageUrl = '';
          if (release.image) {
            processedImageUrl = processImageUrl(release.image, artist.url);
            if (!processedImageUrl) {
              console.log(`Skipping invalid image URL for ${release.title}: ${release.image}`);
            }
          }
          
          // Sanitize content for XML
          let safeDescription = (release.description || `New release by ${artist.name}`)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
          
          let safeTitle = (artist.name + ' - ' + release.title)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
          
          // When preparing URLs, make sure to escape equals signs
          let safeUrl = release.url
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;')
            .replace(/=/g, '%3D');
          
          let safeImageUrl = '';
          if (processedImageUrl) {
            safeImageUrl = processedImageUrl
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&apos;')
              .replace(/=/g, '%3D');
          }
          
          let safeArtistUrl = artist.url
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;')
            .replace(/=/g, '%3D');
          
          // Only include the image in the description if we have a valid image URL
          const enhancedDescription = safeImageUrl 
            ? `<p><img src="${safeImageUrl}" alt="${safeTitle}" style="max-width:100%;"></p>
               <p>${safeDescription}</p>`
            : safeDescription;
          
          try {
            // Prepare feed item with or without image based on URL validity
            const feedItem = {
              title: `${artist.name} - ${release.title}`,
              id: safeUrl,
              link: safeUrl,
              description: enhancedDescription,
              author: [
                {
                  name: artist.name,
                  link: safeArtistUrl
                }
              ],
              date: release.date || new Date()
            };
            
            // Only add image if we have a valid URL
            if (safeImageUrl) {
              feedItem.image = {
                url: safeImageUrl,
                title: safeTitle,
                link: safeUrl
              };
            }
            
            feed.addItem(feedItem);
          } catch (e) {
            console.error(`Error adding feed item ${artist.name} - ${release.title}: ${e.message}`);
          }
        }
        
        const filteredCount = releases.length - realReleases.length;
        totalReleaseCount += realReleases.length;
        
        console.log(`Added ${realReleases.length} releases for ${artist.name} (filtered ${filteredCount} sample/example releases)`);
      } catch (error) {
        console.error(`Error scraping ${artist.name}: ${error.message}`);
      }
    }
    
    console.log(`Total real releases count for ${jsonFile}: ${totalReleaseCount}`);
    console.log(`Total items added to feed: ${feed.items ? feed.items.length : 0}`);
    
    // Determine output file path
    const outputFile = path.join(outputFeedDir, `${feedId}-feed.xml`);

    // Generate and write the feed
    if (totalReleaseCount === 0) {
      console.log(`No actual releases found for ${jsonFile}. Creating minimal feed.`);
      
      // Create a minimal feed with a message
      const rssOutput = `<?xml version="1.0" encoding="utf-8"?>
    <rss version="2.0">
      <channel>
        <title>${feedTitle}</title>
        <description>${feedDescription}</description>
        <link>https://github.com/user/artist-rss-feed-generator</link>
        <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
        <item>
          <title>No Releases Found</title>
          <link>https://github.com/user/artist-rss-feed-generator</link>
          <description>No releases were found for the configured artists. Please check your artists list.</description>
          <pubDate>${new Date().toUTCString()}</pubDate>
          <guid>https://github.com/user/artist-rss-feed-generator/no-releases-${Date.now()}</guid>
        </item>
      </channel>
    </rss>`;
      
      await fs.writeFile(outputFile, rssOutput);
    } else {
      // Try catch block to detect and handle any issues with RSS generation
      try {
        // Generate the RSS feed XML
        console.log(`Generating RSS feed for ${jsonFile} with ${feed.items.length} items`);
        const rssOutput = feed.rss2();
        
        // Debug check - verify the XML output has items
        const hasItems = rssOutput.includes("<item>");
        console.log(`XML output contains items: ${hasItems}`);
        
        // If the feed.rss2() didn't include items, generate manual XML
        if (!hasItems && feed.items.length > 0) {
          console.log("Feed.rss2() failed to include items, using manual XML generation");
          
          // Start with channel info
          let manualRssOutput = `<?xml version="1.0" encoding="utf-8"?>
      <rss version="2.0">
        <channel>
          <title>${feedTitle}</title>
          <description>${feedDescription}</description>
          <link>https://github.com/user/artist-rss-feed-generator</link>
          <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`;
          
          // Add each item manually
          for (const item of feed.items) {
            manualRssOutput += `
          <item>
            <title>${item.title}</title>
            <link>${item.link}</link>
            <guid>${item.id || item.link}</guid>
            <pubDate>${item.date.toUTCString()}</pubDate>
            <description>${item.description}</description>`;
            
            // Add author if available
            if (item.author && item.author.length > 0) {
              manualRssOutput += `
            <author>${item.author[0].name}</author>`;
            }
            
            // Add image if available and valid
            if (item.image && item.image.url) {
              manualRssOutput += `
            <enclosure url="${item.image.url}" type="image/jpeg" />`;
            }
            
            manualRssOutput += `
          </item>`;
          }
          
          // Close the channel and rss tags
          manualRssOutput += `
        </channel>
      </rss>`;
          
          // Write the manually generated RSS
          await fs.writeFile(outputFile, manualRssOutput);
          console.log(`Manually generated RSS feed written to ${outputFile}`);
        } else {
          // Write the feed to the output directory
          await fs.writeFile(outputFile, rssOutput);
          console.log(`Generated RSS feed written to ${outputFile}`);
        }
      } catch (error) {
        console.error(`Error generating RSS for ${jsonFile}: ${error.message}`);
        
        // If RSS generation fails, create a minimal feed as fallback
        console.log(`Creating fallback feed for ${jsonFile} due to RSS generation error`);
        const fallbackOutput = `<?xml version="1.0" encoding="utf-8"?>
    <rss version="2.0">
      <channel>
        <title>${feedTitle}</title>
        <description>${feedDescription}</description>
        <link>https://github.com/user/artist-rss-feed-generator</link>
        <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
        <item>
          <title>Feed Generation Error</title>
          <link>https://github.com/user/artist-rss-feed-generator</link>
          <description>There was an error generating this feed. Please check the artist configuration.</description>
          <pubDate>${new Date().toUTCString()}</pubDate>
          <guid>https://github.com/user/artist-rss-feed-generator/error-${Date.now()}</guid>
        </item>
      </channel>
    </rss>`;
        
        await fs.writeFile(outputFile, fallbackOutput);
      }
    }
    
    // Create the HTML page for this feed
    await createFeedInfoPage(jsonFile, feedId, feedTitle, feedDirectory, totalReleaseCount || 0);
    
  } catch (error) {
    console.error(`Error generating feed for ${jsonFile}:`, error);
    throw error;
  }
}

// Start the process
processArtistFiles().catch(error => {
  console.error('Error in main process:', error);
});
