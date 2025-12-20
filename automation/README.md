# Daily RSS Feed Automation

This directory contains the automation infrastructure for daily RSS feed aggregation and Claude AI summary generation.

## Overview

The system runs headlessly every day at **7:55 AM Eastern Time** via GitHub Actions, automatically:
1. Fetching news from 15+ RSS feeds (AdTech, Marketing, FinTech, Tech, Reddit)
2. Generating strategic AI summaries using Claude
3. Updating `feed.xml` with the latest analysis
4. Committing and pushing changes back to the repository

## Files

- **`daily-update.js`** - Headless Node.js script that performs the daily update
- **`README.md`** - This documentation file
- **`../.github/workflows/daily-summary.yml`** - GitHub Actions workflow configuration

## How It Works

### 1. GitHub Actions Workflow

The workflow (`.github/workflows/daily-summary.yml`) is configured to:
- Run at 7:55 AM Eastern Time (11:55 AM UTC) every day
- Can also be triggered manually via GitHub Actions UI
- Sets up Node.js environment
- Installs dependencies
- Runs the automation script
- Commits and pushes any changes

### 2. Automation Script

The `daily-update.js` script:
- Fetches all RSS feeds in parallel using the rss2json.com API
- Aggregates news items from all sources
- Formats content for Claude AI analysis
- Calls Claude API to generate strategic summary
- Respects the 91-minute throttle window (won't regenerate if recent)
- Updates both `summary_cache.txt` and `feed.xml`
- Exits cleanly for GitHub Actions to commit changes

### 3. Smart Caching

The system implements intelligent caching:
- If a summary was generated within the last 91 minutes, it uses the cached version
- This conserves API quota and prevents unnecessary API calls
- Daily runs will typically generate new summaries (since 24h > 91min)
- Manual triggers respect the throttle window

## Setup Instructions

### Prerequisites

1. Node.js 18+ installed (handled by GitHub Actions)
2. Anthropic Claude API key

### GitHub Setup

1. **Add API Key as GitHub Secret**:
   - Go to your repository settings
   - Navigate to **Secrets and variables** → **Actions**
   - Click **New repository secret**
   - Name: `CLAUDE_API_KEY`
   - Value: Your Anthropic API key
   - Click **Add secret**

2. **Enable GitHub Actions**:
   - Go to **Actions** tab in your repository
   - If prompted, enable GitHub Actions for the repository
   - The workflow will appear as "Daily RSS Feed Summary Update"

3. **Verify Workflow Permissions**:
   - Go to **Settings** → **Actions** → **General**
   - Under "Workflow permissions", ensure "Read and write permissions" is selected
   - This allows the workflow to commit changes back to the repo

### Testing the Automation

#### Manual Trigger (Recommended First Test)

1. Go to the **Actions** tab in your GitHub repository
2. Click on "Daily RSS Feed Summary Update" workflow
3. Click **Run workflow** button
4. Select the branch (e.g., `claude/daily-repo-sync-xml-feed-TB6zi`)
5. Click **Run workflow**
6. Watch the workflow execution in real-time

#### Local Testing

You can also test the automation script locally:

```bash
# Ensure you have dependencies installed
npm install

# Set your API key (or use .env file)
export CLAUDE_API_KEY="your-api-key-here"

# Run the automation script
node automation/daily-update.js
```

Expected output:
```
🚀 Daily RSS Feed Update - Starting...

📡 Fetching RSS feeds...
✅ Fetched 150 news items from 20 sources
🤖 Calling Claude API for summary generation...
✅ Claude summary generated successfully
✅ Cache updated
✅ feed.xml updated successfully

✅ Daily update completed successfully!
📅 Generated at: Dec 20, 2025, 07:55:00 AM EST
⏰ Next update: Dec 20, 2025, 09:26:00 AM EST
```

## Schedule

- **Cron Expression**: `55 11 * * *` (11:55 AM UTC)
- **Time Zone**: Converts to 7:55 AM Eastern Time (EDT)
- **Frequency**: Once per day, every day
- **Note**: During EST (winter), this runs at 6:55 AM EST. Adjust cron to `55 12 * * *` if you need strict 7:55 AM EST year-round

### Adjusting the Schedule

To change the run time, edit `.github/workflows/daily-summary.yml`:

```yaml
on:
  schedule:
    # Format: minute hour day month day-of-week
    # Example: '30 14 * * *' = 2:30 PM UTC daily
    - cron: '55 11 * * *'
```

Common times (UTC to Eastern):
- 7:00 AM EST/EDT: `0 12 * * *` (EST) or `0 11 * * *` (EDT)
- 8:00 AM EST/EDT: `0 13 * * *` (EST) or `0 12 * * *` (EDT)
- 9:00 AM EST/EDT: `0 14 * * *` (EST) or `0 13 * * *` (EDT)

## Monitoring

### Check Workflow Status

1. Go to **Actions** tab in GitHub
2. View recent workflow runs
3. Click on any run to see detailed logs
4. Green checkmark = successful run
5. Red X = failed run (check logs for errors)

### Common Issues

**Issue**: Workflow fails with "CLAUDE_API_KEY is not set"
- **Solution**: Add `CLAUDE_API_KEY` to GitHub Secrets (see Setup Instructions)

**Issue**: Workflow runs but doesn't commit changes
- **Solution**: Ensure "Read and write permissions" are enabled for workflows

**Issue**: Summary not generated (using cached version)
- **Explanation**: This is normal if a summary was recently generated (<91 minutes ago)
- **Solution**: Wait for the throttle window to expire, or manually clear `summary_cache.txt`

**Issue**: RSS feeds failing to fetch
- **Solution**: The rss2json.com proxy may be rate-limited. The script will continue with available feeds.

## Architecture

```
┌─────────────────────────────────────────┐
│   GitHub Actions (Scheduled Trigger)   │
│          7:55 AM ET Daily               │
└───────────────┬─────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────┐
│     daily-update.js (Headless)          │
├─────────────────────────────────────────┤
│ 1. Check cache (91-min throttle)       │
│ 2. Fetch 15+ RSS feeds                  │
│ 3. Aggregate news items                 │
│ 4. Call Claude API                      │
│ 5. Generate strategic summary           │
│ 6. Update summary_cache.txt             │
│ 7. Update feed.xml                      │
└───────────────┬─────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────┐
│   Git Commit & Push (Automated)         │
│   - feed.xml                            │
│   - summary_cache.txt                   │
└─────────────────────────────────────────┘
```

## Output Files

- **`feed.xml`** - RSS 2.0 feed with latest Claude summary
- **`summary_cache.txt`** - Timestamped cache of last summary (prevents duplicate API calls)

## API Usage

- **Model**: Claude Sonnet 4.5 (`claude-sonnet-4-5`)
- **Tokens**: Up to 4,096 tokens per summary
- **Daily Cost**: ~$0.01-0.05 per summary (depending on input length)
- **Monthly Estimate**: ~$0.30-1.50 for daily summaries

## Support

For issues with:
- **GitHub Actions**: Check workflow logs in Actions tab
- **Claude API**: Verify API key and check Anthropic console for quota
- **RSS Feeds**: Some feeds may be temporarily unavailable; the script continues with available feeds
- **Script Errors**: Run locally with `node automation/daily-update.js` for detailed error messages
