'use strict';

/** @module runtime/infrastructure/opportunity-discovery-pipeline */

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute, safeCall, safeCallAsync } = require('../../utils/safe-execute');
const { debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');
const { timestampId } = require('../../utils/unique-id');

const COMPLAINT_KEYWORDS = [
  'wish', 'hate', 'frustrated', 'annoying', 'terrible', 'awful', 'sucks',
  'broken', 'useless', "can't", "doesn't work",
  '太烂', '难用', '崩溃', '替代', '求推荐',
];

const NON_COMPLAINT_KEYWORDS = ['love', 'great', 'amazing', 'awesome', 'perfect'];

const SUPPORTED_PLATFORMS = [
  'reddit', 'hackernews', 'producthunt', 'v2ex', 'stackoverflow', 'github-issues', 'generic',
];

const PLATFORM_TEMPLATE_MAP = {
  reddit: 'reddit-post',
  hackernews: 'hackernews-story',
  producthunt: 'producthunt-post',
  generic: 'generic',
};

const PRODUCT_LENS_MIN_SCORE = 6;

const HIGH_INTENSITY_WORDS = ['terrible', 'awful', 'sucks', 'broken', 'useless', '太烂', '崩溃'];
const MEDIUM_INTENSITY_WORDS = ['hate', 'frustrated', 'annoying', "can't", "doesn't work", '难用'];

const TECH_SOURCES = ['github-trending', 'huggingface', 'arxiv', 'npm-trending', 'product-hunt'];

/**
 * OpportunityDiscoveryPipeline — Vibe Coding Step 1 "Finding Direction" runtime pipeline.
 * Implements three Hunter Paths (Pain Scanning, Competitive Gaps, Tech Dividends)
 * and Product Lens Three-Question Filter as code-enforced execution.
 *
 * @class OpportunityDiscoveryPipeline
 * @classdesc 机会发现管道
 * @extends {EventEmitter}
 * @param {Object} [options] - Configuration options
 * @param {Object} [options.browserAdapter] - BrowserUseAdapter instance
 * @param {Object} [options.knowledgeBasePipeline] - KnowledgeBasePipeline instance
 * @param {Object} [options.ragPipeline] - RAGPipeline instance
 * @param {Object} [options.graphRAG] - GraphRAG instance
 * @param {Object} [options.mcpClient] - MCPClient instance
 * @param {number} [options.minSourcesPerPainPoint=5] - Minimum data sources per validated pain point
 * @param {number} [options.painIntensityThreshold=7] - Minimum pain intensity score (1-10)
 * @param {number} [options.solutionSatisfactionThreshold=4] - Maximum current solution satisfaction (1-10)
 * @param {number} [options.competitorReviewMinCount=20] - Minimum reviews per competitor
 * @param {number} [options.techTrendRecencyDays=90] - Tech trend recency window in days
 */
class OpportunityDiscoveryPipeline extends EventEmitter {
  constructor(options) {
    super();
    const opts = options ?? {};
    this._browserAdapter = opts.browserAdapter ?? null;
    this._knowledgeBasePipeline = opts.knowledgeBasePipeline ?? null;
    this._ragPipeline = opts.ragPipeline ?? null;
    this._graphRAG = opts.graphRAG ?? null;
    this._mcpClient = opts.mcpClient ?? null;
    this._minSourcesPerPainPoint = opts.minSourcesPerPainPoint ?? 5;
    this._painIntensityThreshold = opts.painIntensityThreshold ?? 7;
    this._solutionSatisfactionThreshold = opts.solutionSatisfactionThreshold ?? 4;
    this._competitorReviewMinCount = opts.competitorReviewMinCount ?? 20;
    this._techTrendRecencyDays = opts.techTrendRecencyDays ?? 90;
    this._minFeatureRequestVotes = opts.minFeatureRequestVotes ?? 10;
    this._exaClient = opts.exaApiKey ? {
      apiKey: opts.exaApiKey,
      async search(query, searchOpts = {}) {
        const response = await fetch('https://api.exa.ai/search', {
          method: 'POST',
          headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, numResults: searchOpts.numResults || 10, type: 'neural', contents: { text: true } }),
        });
        if (!response.ok) throw new Error(`Exa API error: ${response.status}`);
        const data = await response.json();
        return (data.results ?? []).map(r => ({ title: r.title || '', url: r.url || '', snippet: r.text ? r.text.substring(0, 200) : '', publishedDate: r.publishedDate || null }));
      },
    } : null;
    this._painPoints = new BoundedMap(200);
    this._competitors = new BoundedMap(50);
    this._techTrends = new BoundedMap(100);
    this._productLensResults = new BoundedMap(50);
    this._discoverySessions = new BoundedMap(30);
    this._stats = {
      totalSessions: 0,
      totalPainPoints: 0,
      totalValidated: 0,
      totalCompetitors: 0,
      totalTechTrends: 0,
      totalProductLensPassed: 0,
      totalProductLensFailed: 0,
      avgPainIntensity: 0,
      avgSourcesPerPainPoint: 0,
    };
    this._initialized = false;
    this._initShutdownState();
  }

  /**
   * Attach a BrowserUseAdapter instance.
   * @param {Object} adapter - BrowserUseAdapter instance
   */
  attachBrowserAdapter(adapter) {
    this.guardShutdown();
    this._browserAdapter = adapter;
  }

  /**
   * Attach a KnowledgeBasePipeline instance.
   * @param {Object} pipeline - KnowledgeBasePipeline instance
   */
  attachKnowledgeBasePipeline(pipeline) {
    this.guardShutdown();
    this._knowledgeBasePipeline = pipeline;
  }

  /**
   * Attach a RAGPipeline instance.
   * @param {Object} pipeline - RAGPipeline instance
   */
  attachRagPipeline(pipeline) {
    this.guardShutdown();
    this._ragPipeline = pipeline;
  }

  /**
   * Attach a GraphRAG instance.
   * @param {Object} graphRAG - GraphRAG instance
   */
  attachGraphRAG(graphRAG) {
    this.guardShutdown();
    this._graphRAG = graphRAG;
  }

  /**
   * Attach an MCPClient instance.
   * @param {Object} client - MCPClient instance
   */
  attachMcpClient(client) {
    this.guardShutdown();
    this._mcpClient = client;
  }

  /**
   * Initialize the pipeline. Sets initialized flag and emits 'initialized'.
   * @returns {Promise<void>}
   */
  async initialize() {
    this.guardShutdown();
    this._initialized = true;
    this.emit('opportunity-discovery:initialized');
  }

  /**
   * Hunter Path 1: Pain Scanning. Scans platforms for user complaints and pain points.
   * @param {string[]} platforms - Platforms to scan (must contain at least one SUPPORTED_PLATFORMS entry)
   * @param {string[]} keywords - Keywords to search for
   * @param {Object} [options] - Additional options
   * @returns {Promise<{painPoints: Object[], totalScanned: number, complaintCount: number, platformResults: Object}>}
   */
  async scanPainPoints(platforms, keywords, options) {
    this.guardShutdown();
    _validatePlatforms(platforms);
    const opts = options ?? {};
    let totalScanned = 0;
    let complaintCount = 0;
    const platformResults = {};
    const allComplaints = [];

    const validPlatforms = platforms.filter(function(p) { return SUPPORTED_PLATFORMS.indexOf(p) !== -1; });
    for (let i = 0; i < validPlatforms.length; i++) {
      if (this._shutDown) break;
      const result = await this._scanPlatform(validPlatforms[i], opts, keywords);
      totalScanned += result.scanned;
      complaintCount += result.complaintCount;
      platformResults[validPlatforms[i]] = { scanned: result.scanned, complaints: result.complaintCount };
      allComplaints.push.apply(allComplaints, result.complaints);
      await this._ingestPlatformData(validPlatforms[i], result.extracted);
    }

    const painPoints = this._buildPainPoints(allComplaints);
    _updateAvgStats(this);

    if (this._shutDown) {
      return {
        painPoints: painPoints,
        totalScanned: totalScanned,
        complaintCount: complaintCount,
        platformResults: platformResults,
      };
    }

    // Deep research enrichment (default enabled)
    if (opts.deepResearch !== false) {
      await this._deepResearch(painPoints);
    }

    this.emit('opportunity-discovery:pain-points-scanned', {
      totalScanned: totalScanned,
      complaintCount: complaintCount,
      painPointCount: painPoints.length,
      platformResults: platformResults,
    });

    return {
      painPoints: painPoints,
      totalScanned: totalScanned,
      complaintCount: complaintCount,
      platformResults: platformResults,
    };
  }

  /**
   * Scan a single platform for complaints.
   * @param {string} platform - Platform name
   * @param {Object} opts - Options
   * @returns {Promise<{scanned: number, complaintCount: number, complaints: Object[], extracted: Object[]}>}
   * @private
   */
  async _scanPlatform(platform, opts, keywords) {
    const templateName = PLATFORM_TEMPLATE_MAP[platform] || 'generic';
    let extracted = [];

    // Pass keywords to browser adapter for filtering
    if (keywords && Array.isArray(keywords) && keywords.length > 0) {
      opts.keywords = keywords;
    }

    if (this._browserAdapter && typeof this._browserAdapter.extractByTemplate === 'function') {
      extracted = await safeExecute(
        function() { return this._browserAdapter.extractByTemplate(templateName, opts.url); }.bind(this),
        'OpportunityDiscoveryPipeline', 'scanPainPoints:' + platform,
        [],
      );
    }
    if (!Array.isArray(extracted)) { extracted = []; }

    const complaints = [];
    for (let j = 0; j < extracted.length; j++) {
      if (this._shutDown) break;
      const item = extracted[j];
      const text = _extractText(item);
      const classification = _classifyText(text);
      if (classification.isComplaint) {
        complaints.push({
          text: text,
          platform: platform,
          intensity: classification.intensity,
          keywords: classification.matchedKeywords,
          source: item,
        });
      }
    }

    return { scanned: extracted.length, complaintCount: complaints.length, complaints: complaints, extracted: extracted };
  }

  /**
   * Ingest platform data into KnowledgeBasePipeline.
   * @param {string} platform - Platform name
   * @param {Object[]} extracted - Extracted data items
   * @private
   */
  async _ingestPlatformData(platform, extracted) {
    if (!this._knowledgeBasePipeline || typeof this._knowledgeBasePipeline.ingestRaw !== 'function') return;
    for (let k = 0; k < extracted.length; k++) {
      await safeCallAsync(
        function() { return this._knowledgeBasePipeline.ingestRaw('pain-scan/' + platform + '/' + timestampId('pp-'), JSON.stringify(extracted[k]), { platform: platform }); }.bind(this),
        'OpportunityDiscoveryPipeline', 'ingestRaw:' + platform,
      );
    }
  }

  /**
   * Build pain points from grouped complaints.
   * @param {Object[]} allComplaints - All complaints
   * @returns {Object[]} Pain point objects
   * @private
   */
  _buildPainPoints(allComplaints) {
    const groups = _groupComplaints(allComplaints);
    const painPoints = [];

    groups.forEach(function(group) {
      const painPointId = timestampId('pp-');
      const sources = group.map(function(c) { return { platform: c.platform, text: c.text }; });
      const frequency = sources.length;
      const intensity = _averageIntensity(group);
      const satisfaction = _inferSatisfaction(group);
      const category = _inferCategory(group);

      const entry = {
        description: group[0].text.slice(0, 200),
        sources: sources,
        frequency: frequency,
        intensity: intensity,
        satisfaction: satisfaction,
        category: category,
        validated: frequency >= this._minSourcesPerPainPoint && intensity >= this._painIntensityThreshold,
        createdAt: new Date().toISOString(),
      };

      this._painPoints.set(painPointId, entry);
      painPoints.push({ id: painPointId, ...entry });
      this._stats.totalPainPoints++;
    }, this);

    return painPoints;
  }

  /**
   * Deep research enrichment for pain points using MCP client.
   * Takes top N pain points (by intensity * frequency) and performs LLM-based deep analysis.
   * @param {Object[]} painPoints - Pain points to enrich
   * @param {number} [topN=5] - Number of top pain points to research
   * @returns {Promise<void>} Enriches pain points in-place with deepAnalysis field
   * @private
   */
  async _deepResearch(painPoints, topN) {
    if (!Array.isArray(painPoints) || painPoints.length === 0) return;
    this.guardShutdown();
    if (!this._mcpClient || typeof this._mcpClient.search !== 'function') return;
    const n = topN ?? 5;
    const sorted = painPoints.slice().sort(function(a, b) {
      return (b.intensity * b.frequency) - (a.intensity * a.frequency);
    });
    const topPoints = sorted.slice(0, n);

    for (let i = 0; i < topPoints.length; i++) {
      if (this._shutDown) break;
      const pp = topPoints[i];
      const query = 'deep analysis root causes: ' + pp.description.slice(0, 120);
      const results = await safeExecute(
        function() { return this._mcpClient.search(query); }.bind(this),
        'OpportunityDiscoveryPipeline', 'deepResearch:' + (pp.id || i),
        [],
      );
      if (this._shutDown) return;
      if (!Array.isArray(results)) continue;

      const rootCauses = [];
      const crossPlatformPatterns = [];
      let sentimentDepth = pp.intensity;

      for (let j = 0; j < results.length; j++) {
        const text = _extractText(results[j]);
        if (!text) continue;
        const rootMatch = text.match(/(?:root\s+cause|because|due\s+to|caused\s+by|reason)[:\s]+(.{10,150})/i);
        if (rootMatch) rootCauses.push(rootMatch[1].trim().slice(0, 200));
        const platformMatch = text.match(/(?:reddit|hackernews|stackoverflow|github|v2ex|producthunt)[:\s]+(.{5,100})/i);
        if (platformMatch) crossPlatformPatterns.push(platformMatch[1].trim().slice(0, 150));
        const classification = _classifyText(text);
        if (classification.isComplaint) {
          sentimentDepth = Math.max(sentimentDepth, classification.intensity);
        }
      }

      pp.deepAnalysis = {
        rootCauses: rootCauses.slice(0, 5),
        sentimentDepth: Math.round(sentimentDepth * 10) / 10,
        crossPlatformPatterns: crossPlatformPatterns.slice(0, 5),
      };

      // Also update in the BoundedMap store
      if (pp.id) {
        const stored = this._painPoints.get(pp.id);
        if (stored) {
          stored.deepAnalysis = pp.deepAnalysis;
        }
      }
    }
  }

  /**
   * Exa search adapter for real-time web search capability.
   * Falls back to MCPClient.search() if Exa is not configured.
   * @param {string} query - Search query
   * @param {Object} [options] - Search options
   * @param {number} [options.maxResults=5] - Maximum number of results
   * @returns {Promise<Array<{title: string, url: string, snippet: string, publishedDate: string|null}>>}
   * @private
   */
  async _exaSearch(query, options) {
    this.guardShutdown();
    if (!query || typeof query !== 'string') return [];
    if (query.length > 500) query = query.substring(0, 500);
    const opts = options ?? {};
    const maxResults = opts.maxResults ?? 5;

    if (this._exaClient && this._exaClient.apiKey) {
      const results = await safeExecute(
        function() {
          return this._exaClient.search(query, { numResults: maxResults });
        }.bind(this),
        'OpportunityDiscoveryPipeline', 'exaSearch',
        [],
      );
      if (this._shutDown) return [];
      if (Array.isArray(results)) {
        return results.slice(0, maxResults).map(function(r) {
          return {
            title: r.title || '',
            url: r.url || '',
            snippet: r.text ? r.text.slice(0, 300) : '',
            publishedDate: r.publishedDate || null,
          };
        });
      }
    }

    // Fallback to MCPClient with enhanced query formatting
    if (this._mcpClient && typeof this._mcpClient.search === 'function') {
      const enhancedQuery = query + ' latest review comparison 2024 2025';
      const results = await safeExecute(
        function() { return this._mcpClient.search(enhancedQuery); }.bind(this),
        'OpportunityDiscoveryPipeline', 'exaSearch:fallback',
        [],
      );
      if (this._shutDown) return [];
      if (Array.isArray(results)) {
        return results.slice(0, maxResults).map(function(r) {
          const text = _extractText(r);
          return {
            title: r.title || '',
            url: r.url || '',
            snippet: text.slice(0, 300),
            publishedDate: _extractDate(r) ? _extractDate(r).toISOString() : null,
          };
        });
      }
    }

    return [];
  }

  /**
   * Hunter Path 2: Competitive Gaps. Analyzes competitors for weaknesses and feature gaps.
   * @param {string[]} competitorNames - Names of competitors to analyze
   * @param {Object} [options] - Additional options
   * @returns {Promise<{competitors: Object[], gapMatrix: Object, uniqueGaps: string[], totalReviewsAnalyzed: number}>}
   */
  async analyzeCompetitiveGaps(competitorNames, options) {
    this.guardShutdown();
    if (!Array.isArray(competitorNames) || competitorNames.length === 0) {
      throw new Error('competitorNames must be a non-empty array');
    }
    const opts = options ?? {};
    let totalReviewsAnalyzed = 0;
    const competitors = [];
    const allFeatures = {};
    const gapMatrix = {};

    for (let i = 0; i < competitorNames.length; i++) {
      if (this._shutDown) break;
      const result = await this._analyzeCompetitor(competitorNames[i], opts, allFeatures);
      totalReviewsAnalyzed += result.reviewCount;
      this._competitors.set(result.competitorId, result.entry);
      competitors.push({ id: result.competitorId, ...result.entry });
      this._stats.totalCompetitors++;
      gapMatrix[competitorNames[i]] = {
        weaknesses: result.entry.weaknesses.length,
        featureRequests: result.entry.featureRequests.length,
        avgRating: result.entry.avgRating,
        reviewCount: result.entry.reviewCount,
      };
    }

    const uniqueGaps = Object.keys(allFeatures).filter(function(f) {
      return allFeatures[f] === 1;
    });

    // Filter out competitors with fewer reviews than the configured minimum
    const minReviews = this._competitorReviewMinCount;
    const filteredCompetitors = competitors.filter(function(c) { return c.reviewCount >= minReviews; });
    const filteredGapMatrix = {};
    for (const name of Object.keys(gapMatrix)) {
      if (gapMatrix[name].reviewCount >= minReviews) {
        filteredGapMatrix[name] = gapMatrix[name];
      }
    }

    // Alternative positioning analysis
    const alternativePositioning = this._analyzeAlternativePositioning(filteredGapMatrix, filteredCompetitors);

    if (this._shutDown) {
      return {
        competitors: filteredCompetitors,
        gapMatrix: filteredGapMatrix,
        uniqueGaps: uniqueGaps,
        totalReviewsAnalyzed: totalReviewsAnalyzed,
        alternativePositioning: alternativePositioning,
      };
    }

    this.emit('opportunity-discovery:competitive-gaps-analyzed', {
      competitorCount: filteredCompetitors.length,
      uniqueGaps: uniqueGaps.length,
      totalReviewsAnalyzed: totalReviewsAnalyzed,
    });

    return {
      competitors: filteredCompetitors,
      gapMatrix: filteredGapMatrix,
      uniqueGaps: uniqueGaps,
      totalReviewsAnalyzed: totalReviewsAnalyzed,
      alternativePositioning: alternativePositioning,
    };
  }

  /**
   * Analyze a single competitor.
   * @param {string} name - Competitor name
   * @param {Object} opts - Options
   * @param {Object} allFeatures - Shared feature frequency map
   * @returns {Promise<{competitorId: string, entry: Object, reviewCount: number}>}
   * @private
   */
  async _analyzeCompetitor(name, opts, allFeatures) {
    const competitorId = timestampId('comp-');
    const weaknesses = [];
    const featureRequests = [];
    let reviewCount = 0;
    let ratingSum = 0;

    if (this._browserAdapter && typeof this._browserAdapter.extractByTemplate === 'function') {
      const reviewUrls = opts.reviewUrls ?? [];
      const browserResult = await this._extractCompetitorReviews(name, reviewUrls);
      reviewCount += browserResult.reviewCount;
      ratingSum += browserResult.ratingSum;
      weaknesses.push.apply(weaknesses, browserResult.weaknesses);
      featureRequests.push.apply(featureRequests, browserResult.featureRequests);
      for (let f = 0; f < browserResult.featureRequests.length; f++) {
        const key = (typeof browserResult.featureRequests[f] === 'string'
          ? browserResult.featureRequests[f]
          : browserResult.featureRequests[f].text || '').toLowerCase();
        if (key) allFeatures[key] = (allFeatures[key] ?? 0) + 1;
      }
    }

    if (this._mcpClient && typeof this._mcpClient.search === 'function') {
      const mcpResult = await this._mcpCompetitorSearch(name);
      reviewCount += mcpResult.reviewCount;
      weaknesses.push.apply(weaknesses, mcpResult.weaknesses);
    }

    const avgRating = reviewCount > 0 ? Math.round((ratingSum / reviewCount) * 10) / 10 : 0;
    const minVotes = this._minFeatureRequestVotes;
    const filteredFeatureRequests = featureRequests.filter(function(fr) {
      if (typeof fr === 'string') return true;
      // Intentionally includes stale planned requests (ageInDays > 365) as they signal long-unmet demand
      return fr.votes >= minVotes || (fr.status === 'planned' && fr.ageInDays !== null && fr.ageInDays > 365);
    });
    const gaps = filteredFeatureRequests.filter(function(f) {
      const key = typeof f === 'string' ? f.toLowerCase() : (f.text || '').toLowerCase();
      return allFeatures[key] === 1;
    });

    const entry = {
      name: name,
      weaknesses: weaknesses,
      featureRequests: filteredFeatureRequests,
      reviewCount: reviewCount,
      avgRating: avgRating,
      gaps: gaps,
    };

    return { competitorId: competitorId, entry: entry, reviewCount: reviewCount };
  }

  /**
   * Extract competitor reviews via browser adapter.
   * @param {string} name - Competitor name
   * @param {string[]} reviewUrls - Review page URLs
   * @returns {Promise<{reviewCount: number, ratingSum: number, weaknesses: string[], featureRequests: string[]}>}
   * @private
   */
  async _extractCompetitorReviews(name, reviewUrls) {
    let reviewCount = 0;
    let ratingSum = 0;
    const weaknesses = [];
    const featureRequests = [];

    for (let j = 0; j < reviewUrls.length; j++) {
      if (this._shutDown) break;
      const reviews = await safeExecute(
        function() { return this._browserAdapter.extractByTemplate('generic', reviewUrls[j]); }.bind(this),
        'OpportunityDiscoveryPipeline', 'analyzeCompetitiveGaps:' + name,
        [],
      );
      if (!Array.isArray(reviews)) { continue; }
      for (let k = 0; k < reviews.length; k++) {
        const review = reviews[k];
        const text = _extractText(review);
        reviewCount++;
        const classification = _classifyText(text);
        if (classification.isComplaint) {
          weaknesses.push(text.slice(0, 200));
        }
        const wishMatch = text.match(/i wish\s+(.{5,100})/i);
        if (wishMatch) {
          const frText = wishMatch[1].trim();
          const voteMatch = text.match(/(\d+)\s*(upvotes?|votes?|likes?|⬆)/i);
          const statusMatch = text.match(/status:\s*(planned|under review|declined|implemented)/i);
          const ageMatch = text.match(/posted\s+(\d+)\s+(days?|months?|years?)\s+ago/i);
          let ageInDays = null;
          if (ageMatch) {
            const num = parseInt(ageMatch[1], 10);
            const unit = ageMatch[2].toLowerCase();
            if (Number.isFinite(num)) {
              if (unit.startsWith('day')) ageInDays = num;
              else if (unit.startsWith('month')) ageInDays = num * 30;
              else if (unit.startsWith('year')) ageInDays = num * 365;
            }
          }
          featureRequests.push({
            text: frText,
            votes: voteMatch ? (Number.isFinite(parseInt(voteMatch[1], 10)) ? parseInt(voteMatch[1], 10) : 0) : 0,
            status: statusMatch ? statusMatch[1].toLowerCase() : null,
            ageInDays: ageInDays,
          });
        }
        const rating = _extractRating(review);
        if (rating > 0) { ratingSum += rating; }
      }
    }

    return { reviewCount: reviewCount, ratingSum: ratingSum, weaknesses: weaknesses, featureRequests: featureRequests };
  }

  /**
   * Search competitor data via MCP client.
   * @param {string} name - Competitor name
   * @returns {Promise<{reviewCount: number, weaknesses: string[]}>}
   * @private
   */
  async _mcpCompetitorSearch(name) {
    let reviewCount = 0;
    const weaknesses = [];
    const searchResults = await safeExecute(
      function() { return this._mcpClient.search(name + ' review complaints weaknesses'); }.bind(this),
      'OpportunityDiscoveryPipeline', 'mcpSearch:' + name,
      [],
    );
    if (Array.isArray(searchResults)) {
      for (let s = 0; s < searchResults.length; s++) {
        const text = _extractText(searchResults[s]);
        if (text) {
          reviewCount++;
          const classification = _classifyText(text);
          if (classification.isComplaint) {
            weaknesses.push(text.slice(0, 200));
          }
        }
      }
    }
    return { reviewCount: reviewCount, weaknesses: weaknesses };
  }

  /**
   * Hunter Path 3: Tech Dividends. Discovers new technology opportunities and edge cases.
   * @param {string[]} technologies - Technologies to investigate
   * @param {Object} [options] - Additional options
   * @returns {Promise<{techTrends: Object[], opportunities: Object[], totalSearched: number}>}
   */
  async discoverTechDividends(technologies, options) {
    this.guardShutdown();
    if (!Array.isArray(technologies) || technologies.length === 0) {
      throw new Error('technologies must be a non-empty array');
    }
    const opts = options ?? {};
    let totalSearched = 0;
    const techTrends = [];
    const opportunities = [];
    const now = Date.now();
    const recencyThreshold = this._techTrendRecencyDays * 24 * 60 * 60 * 1000;

    for (let i = 0; i < technologies.length; i++) {
      if (this._shutDown) break;
      const result = await this._discoverTechOpportunities(technologies[i], opts, now, recencyThreshold);
      totalSearched += result.totalSearched;
      this._techTrends.set(result.trendId, result.entry);
      techTrends.push({ id: result.trendId, ...result.entry });
      this._stats.totalTechTrends++;
      for (let o = 0; o < result.techOpportunities.length; o++) {
        opportunities.push({
          technology: technologies[i],
          description: result.techOpportunities[o],
          recency: result.recency,
        });
      }

      // Search across multiple tech sources
      const sources = opts.techSources || TECH_SOURCES;
      for (let s = 0; s < sources.length; s++) {
        if (this._shutDown) break;
        const sourceResult = await this._searchTechSource(sources[s], technologies[i]);
        totalSearched += sourceResult.totalSearched;
        for (let o = 0; o < sourceResult.opportunities.length; o++) {
          opportunities.push({
            technology: technologies[i],
            description: sourceResult.opportunities[o],
            source: sources[s],
            recency: 0.5,
          });
        }
      }
    }

    if (this._shutDown) {
      return {
        techTrends: techTrends,
        opportunities: opportunities,
        totalSearched: totalSearched,
      };
    }

    this.emit('opportunity-discovery:tech-dividends-discovered', {
      techTrendCount: techTrends.length,
      opportunityCount: opportunities.length,
      totalSearched: totalSearched,
    });

    return {
      techTrends: techTrends,
      opportunities: opportunities,
      totalSearched: totalSearched,
    };
  }

  /**
   * Discover tech opportunities for a single technology.
   * @param {string} tech - Technology name
   * @param {Object} opts - Options
   * @param {number} now - Current timestamp
   * @param {number} recencyThreshold - Recency threshold in ms
   * @returns {Promise<{trendId: string, entry: Object, totalSearched: number, techOpportunities: string[], recency: number}>}
   * @private
   */
  async _discoverTechOpportunities(tech, opts, now, recencyThreshold) {
    const trendId = timestampId('tech-');
    const edgeCases = [];
    const techOpportunities = [];
    let recency = 0;
    let source = 'unknown';
    let totalSearched = 0;

    if (this._mcpClient && typeof this._mcpClient.search === 'function') {
      const mcpResult = await this._mcpTechSearch(tech, now, recencyThreshold);
      totalSearched += mcpResult.totalSearched;
      recency = mcpResult.recency;
      edgeCases.push.apply(edgeCases, mcpResult.edgeCases);
      techOpportunities.push.apply(techOpportunities, mcpResult.opportunities);
      source = 'mcp';
    }

    if (this._browserAdapter && typeof this._browserAdapter.extractByTemplate === 'function') {
      const browserResult = await this._browserTechSearch(tech, opts);
      totalSearched += browserResult.totalSearched;
      edgeCases.push.apply(edgeCases, browserResult.edgeCases);
      techOpportunities.push.apply(techOpportunities, browserResult.opportunities);
      source = source === 'unknown' ? 'browser' : source + '+browser';
    }

    if (recency === 0) {
      recency = 0.5;
    }

    const entry = {
      technology: tech,
      edgeCases: edgeCases,
      opportunities: techOpportunities,
      recency: Math.round(recency * 100) / 100,
      source: source,
    };

    return { trendId: trendId, entry: entry, totalSearched: totalSearched, techOpportunities: techOpportunities, recency: recency };
  }

  /**
   * Search tech data via MCP client.
   * @param {string} tech - Technology name
   * @param {number} now - Current timestamp
   * @param {number} recencyThreshold - Recency threshold in ms
   * @returns {Promise<{totalSearched: number, recency: number, edgeCases: string[], opportunities: string[]}>}
   * @private
   */
  async _mcpTechSearch(tech, now, recencyThreshold) {
    let totalSearched = 0;
    let recency = 0;
    const edgeCases = [];
    const opportunities = [];

    const results = await safeExecute(
      function() { return this._mcpClient.search(tech + ' edge cases new applications 2024 2025'); }.bind(this),
      'OpportunityDiscoveryPipeline', 'discoverTechDividends:' + tech,
      [],
    );
    if (Array.isArray(results)) {
      totalSearched += results.length;
      for (let j = 0; j < results.length; j++) {
        const item = results[j];
        const text = _extractText(item);
        const publishedDate = _extractDate(item);
        if (publishedDate) {
          const age = now - publishedDate.getTime();
          if (age < recencyThreshold) {
            recency = Math.max(recency, 1 - age / recencyThreshold);
          }
        }
        _extractTechSignals(text, edgeCases, opportunities);
      }
    }

    return { totalSearched: totalSearched, recency: recency, edgeCases: edgeCases, opportunities: opportunities };
  }

  /**
   * Search tech data via browser adapter.
   * @param {string} tech - Technology name
   * @param {Object} opts - Options
   * @returns {Promise<{totalSearched: number, edgeCases: string[], opportunities: string[]}>}
   * @private
   */
  async _browserTechSearch(tech, opts) {
    let totalSearched = 0;
    const edgeCases = [];
    const opportunities = [];
    const searchUrls = opts.searchUrls ?? [];

    for (let j = 0; j < searchUrls.length; j++) {
      if (this._shutDown) break;
      const results = await safeExecute(
        function() { return this._browserAdapter.extractByTemplate('generic', searchUrls[j]); }.bind(this),
        'OpportunityDiscoveryPipeline', 'discoverTechDividends:browser:' + tech,
        [],
      );
      if (Array.isArray(results)) {
        totalSearched += results.length;
        for (let k = 0; k < results.length; k++) {
          const text = _extractText(results[k]);
          _extractTechSignals(text, edgeCases, opportunities);
        }
      }
    }

    return { totalSearched: totalSearched, edgeCases: edgeCases, opportunities: opportunities };
  }

  /**
   * Search a specific tech source for technology opportunities.
   * Constructs source-specific search queries for each source.
   * @param {string} source - Tech source name (from TECH_SOURCES)
   * @param {string} technology - Technology name to search for
   * @returns {Promise<{totalSearched: number, opportunities: string[]}>}
   * @private
   */
  async _searchTechSource(source, technology) {
    if (!TECH_SOURCES.includes(source)) return { totalSearched: 0, opportunities: [] };
    const sourceQueries = {
      'github-trending': technology + ' trending repository stars new release',
      'huggingface': technology + ' model dataset new release huggingface',
      'arxiv': technology + ' research paper arxiv new approach',
      'npm-trending': technology + ' npm package trending download new',
      'product-hunt': technology + ' product launch new tool producthunt',
    };
    const query = sourceQueries[source] || (technology + ' ' + source + ' new trending');
    const opportunities = [];
    let totalSearched = 0;

    if (this._mcpClient && typeof this._mcpClient.search === 'function') {
      const results = await safeExecute(
        function() { return this._mcpClient.search(query); }.bind(this),
        'OpportunityDiscoveryPipeline', 'searchTechSource:' + source + ':' + technology,
        [],
      );
      if (this._shutDown) return [];
      if (Array.isArray(results)) {
        totalSearched += results.length;
        for (let j = 0; j < results.length; j++) {
          const text = _extractText(results[j]);
          const edgeCases = [];
          const opps = [];
          _extractTechSignals(text, edgeCases, opps);
          for (let k = 0; k < opps.length; k++) {
            opportunities.push(opps[k]);
          }
        }
      }
    }

    return { totalSearched: totalSearched, opportunities: opportunities };
  }

  /**
   * Analyze alternative positioning strategies against competitors.
   * Identifies competitors with the most weaknesses and suggests positioning strategies.
   * @param {Object} gapMatrix - Gap matrix from competitive analysis
   * @param {Object[]} competitors - Competitor data
   * @returns {{strategy: string, targetCompetitor: string, differentiators: string[], positioning: string}}
   * @private
   */
  _analyzeAlternativePositioning(gapMatrix, competitors) {
    this.guardShutdown();
    if (!gapMatrix || Object.keys(gapMatrix).length === 0 || !competitors || competitors.length === 0) return null;
    let targetCompetitor = '';
    let maxWeaknesses = 0;

    for (const name of Object.keys(gapMatrix)) {
      if (gapMatrix[name].weaknesses > maxWeaknesses) {
        maxWeaknesses = gapMatrix[name].weaknesses;
        targetCompetitor = name;
      }
    }

    if (!targetCompetitor && competitors.length > 0) {
      targetCompetitor = competitors[0].name || '';
    }

    // Select strategy based on competitor profile
    let strategy = 'lightweight_alternative';
    const targetData = gapMatrix[targetCompetitor];
    if (targetData) {
      if (targetData.avgRating <= 3) strategy = 'price_disruption';
      else if (targetData.featureRequests > 5) strategy = 'vertical_specialization';
      else if (targetData.weaknesses > 3) strategy = 'lightweight_alternative';
      else strategy = 'integration_play';
    }

    // Build differentiators from weaknesses
    const differentiators = [];
    const targetCompetitorObj = competitors.find(function(c) { return c.name === targetCompetitor; });
    if (targetCompetitorObj && targetCompetitorObj.weaknesses) {
      for (let i = 0; i < Math.min(targetCompetitorObj.weaknesses.length, 3); i++) {
        differentiators.push(targetCompetitorObj.weaknesses[i].slice(0, 100));
      }
    }

    const positioningMap = {
      lightweight_alternative: 'A simpler, faster alternative to ' + targetCompetitor,
      vertical_specialization: 'Deep specialization for underserved segments of ' + targetCompetitor + '\'s market',
      price_disruption: 'Disruptive pricing targeting ' + targetCompetitor + '\'s cost-sensitive users',
      integration_play: 'Seamless integration play complementing or replacing ' + targetCompetitor,
    };

    return {
      strategy: strategy,
      targetCompetitor: targetCompetitor,
      differentiators: differentiators,
      positioning: positioningMap[strategy] || 'Alternative approach to ' + targetCompetitor,
    };
  }

  /**
   * Generate a user persona from pain points and competitor data.
   * Analyzes pain point categories and source platforms to infer user demographics.
   * @param {Object[]} painPoints - Pain points to analyze
   * @param {Object[]} [competitors] - Competitor data
   * @returns {{primarySegment: string, demographics: Object, painProfile: Object, techSavviness: string, budgetHint: string}}
   * @private
   */
  _generatePersona(painPoints, _competitors) {
    this.guardShutdown();
    const categoryCounts = Object.create(null);
    const platformCounts = Object.create(null);
    let totalIntensity = 0;

    for (let i = 0; i < painPoints.length; i++) {
      const pp = painPoints[i];
      const cat = pp.category || 'general';
      categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
      totalIntensity += pp.intensity ?? 0;
      if (pp.sources) {
        for (let j = 0; j < pp.sources.length; j++) {
          const platform = pp.sources[j].platform || 'unknown';
          platformCounts[platform] = (platformCounts[platform] ?? 0) + 1;
        }
      }
    }

    const topCategory = Object.keys(categoryCounts).sort(function(a, b) {
      return categoryCounts[b] - categoryCounts[a];
    })[0] || 'general';

    const topPlatform = Object.keys(platformCounts).sort(function(a, b) {
      return platformCounts[b] - platformCounts[a];
    })[0] || 'unknown';

    const segmentMap = {
      pricing: 'cost-conscious buyers',
      performance: 'performance-sensitive engineers',
      'feature-gap': 'feature-seeking power users',
      usability: 'usability-focused end users',
      reliability: 'stability-dependent operators',
      support: 'support-dependent enterprises',
      general: 'general users',
    };

    const techSavvyPlatforms = ['hackernews', 'stackoverflow', 'github-issues'];
    const isTechSavvy = techSavvyPlatforms.indexOf(topPlatform) !== -1;
    const avgIntensity = painPoints.length > 0 ? totalIntensity / painPoints.length : 5;

    return {
      primarySegment: segmentMap[topCategory] || 'general users',
      demographics: { topCategory: topCategory, topPlatform: topPlatform, painPointCount: painPoints.length },
      painProfile: { topCategory: topCategory, avgIntensity: Math.round(avgIntensity * 10) / 10, categoryDistribution: categoryCounts },
      techSavviness: isTechSavvy ? 'high' : (topPlatform === 'reddit' ? 'medium' : 'low'),
      budgetHint: topCategory === 'pricing' ? 'price-sensitive' : (topCategory === 'support' ? 'enterprise-budget' : 'mixed'),
    };
  }

  /**
   * Product Lens Three-Question Filter. Validates a direction against who/how painful/why now criteria.
   * @param {Object} direction - Direction to validate
   * @param {string} direction.description - Description of the direction
   * @param {string} direction.targetUser - Target user description
   * @param {Array} direction.painPoints - Array of pain point IDs or objects
   * @param {Object} direction.timing - Timing context
   * @returns {{passed: boolean, scores: Object, direction: Object, unmetCriteria: string[]}}
   */
  validateWithProductLens(direction) {
    this.guardShutdown();
    _validateDirection(direction);

    const whoScore = _scoreTargetUser(direction.targetUser);
    const painData = this._aggregatePainData(direction.painPoints);
    const howPainful = painData.count > 0 ? Math.round((painData.intensitySum / painData.count) * 10) / 10 : 0;
    const avgSatisfaction = painData.count > 0 ? Math.round((painData.satisfactionSum / painData.count) * 10) / 10 : 10;
    const whyNow = _scoreTiming(direction.timing);
    const overall = Math.round(((whoScore + howPainful + whyNow) / 3) * 10) / 10;

    const unmetCriteria = _checkUnmetCriteria(whoScore, howPainful, whyNow, avgSatisfaction, painData, this);
    const passed = unmetCriteria.length === 0;

    const directionId = timestampId('dir-');
    const result = { who: whoScore, howPainful: howPainful, whyNow: whyNow, overall: overall };

    this._productLensResults.set(directionId, {
      who: whoScore,
      howPainful: howPainful,
      whyNow: whyNow,
      passed: passed,
      scores: result,
    });

    if (passed) {
      this._stats.totalProductLensPassed++;
    } else {
      this._stats.totalProductLensFailed++;
    }

    this.emit('opportunity-discovery:product-lens-validated', {
      directionId: directionId,
      passed: passed,
      scores: result,
      unmetCriteria: unmetCriteria,
    });

    return {
      passed: passed,
      scores: result,
      direction: direction,
      unmetCriteria: unmetCriteria,
    };
  }

  /**
   * Aggregate pain data from direction's pain points.
   * @param {Array} painPoints - Array of pain point IDs or objects
   * @returns {{intensitySum: number, satisfactionSum: number, count: number, sourcesCount: number}}
   * @private
   */
  _aggregatePainData(painPoints) {
    if (!Array.isArray(painPoints)) return { intensitySum: 0, satisfactionSum: 0, count: 0, sourcesCount: 0 };
    let intensitySum = 0;
    let satisfactionSum = 0;
    let sourcesCount = 0;

    for (let i = 0; i < painPoints.length; i++) {
      const pp = painPoints[i];
      if (typeof pp === 'string') {
        const stored = this._painPoints.get(pp);
        if (stored) {
          intensitySum += stored.intensity;
          satisfactionSum += stored.satisfaction;
          sourcesCount += stored.sources.length;
        } else {
          intensitySum += 5;
          satisfactionSum += 5;
        }
      } else if (pp && typeof pp === 'object') {
        intensitySum += pp.intensity ?? 5;
        satisfactionSum += pp.satisfaction ?? 5;
        sourcesCount += (pp.sources && pp.sources.length) || 1;
      }
    }

    return { intensitySum: intensitySum, satisfactionSum: satisfactionSum, count: painPoints.length, sourcesCount: sourcesCount };
  }

  /**
   * Full Discovery Pipeline. Runs all three Hunter Paths and Product Lens validation.
   * @param {Object} [options] - Pipeline options
   * @param {string[]} [options.platforms] - Platforms to scan
   * @param {string[]} [options.keywords] - Keywords for pain scanning
   * @param {string[]} [options.competitorNames] - Competitors to analyze
   * @param {string[]} [options.technologies] - Technologies to investigate
   * @param {Object[]} [options.candidateDirections] - Directions to validate
   * @returns {Promise<{sessionId: string, painPoints: Object[], competitiveAnalysis: Object, direction: Object|null, productLensResults: Object[], stats: Object}>}
   */
  async runFullDiscovery(options) {
    this.guardShutdown();
    const opts = options ?? {};
    const sessionId = timestampId('disc-');

    this._discoverySessions.set(sessionId, {
      startedAt: new Date().toISOString(),
      completedAt: null,
      hunterPaths: { pain: false, competitive: false, tech: false },
      painPointCount: 0,
      validatedCount: 0,
      direction: null,
    });
    this._stats.totalSessions++;

    // Step 1: Pain Scanning
    const platforms = opts.platforms || ['generic'];
    const keywords = opts.keywords ?? [];
    const painResult = await this.scanPainPoints(platforms, keywords, opts.scanOptions);
    if (this._shutDown) return { status: 'aborted', sessionId: sessionId };

    const session = this._discoverySessions.get(sessionId);
    if (session) { session.hunterPaths.pain = true; session.painPointCount = painResult.painPoints.length; }

    // Step 2: Competitive Gaps
    const competitorNames = opts.competitorNames || _extractCompetitorNames(painResult.painPoints);
    const competitiveResult = await this.analyzeCompetitiveGaps(competitorNames, opts.competitiveOptions);
    if (this._shutDown) return { status: 'aborted', sessionId: sessionId };

    const session2 = this._discoverySessions.get(sessionId);
    if (session2) { session2.hunterPaths.competitive = true; }

    // Step 3: Tech Dividends
    const technologies = opts.technologies || _extractTechnologies(painResult.painPoints);
    const techResult = await this.discoverTechDividends(technologies, opts.techOptions);
    if (this._shutDown) return { status: 'aborted', sessionId: sessionId };

    const session3 = this._discoverySessions.get(sessionId);
    if (session3) { session3.hunterPaths.tech = true; }

    // Step 4: Product Lens Validation
    const candidateDirections = opts.candidateDirections || _buildCandidateDirections(painResult.painPoints, competitiveResult, techResult, this);
    const validationResult = this._validateCandidates(candidateDirections, sessionId);
    if (this._shutDown) return { status: 'aborted', sessionId: sessionId };

    // Step 5: Generate outputs
    const sortedPainPoints = painResult.painPoints.slice().sort(function(a, b) {
      return (b.intensity * b.frequency) - (a.intensity * a.frequency);
    });

    const competitiveAnalysis = {
      competitors: competitiveResult.competitors,
      gapMatrix: competitiveResult.gapMatrix,
      uniqueGaps: competitiveResult.uniqueGaps,
    };

    const direction = validationResult.bestDirection ? {
      description: validationResult.bestDirection.description,
      targetUser: validationResult.bestDirection.targetUser,
      oneSentence: _generateOneSentenceDirection({
        ...validationResult.bestDirection,
        uniqueGaps: competitiveResult.uniqueGaps,
        gapMatrix: competitiveResult.gapMatrix,
      }, validationResult.bestScore),
      score: validationResult.bestScore,
    } : null;

    // Step 6: Ingest outputs into KnowledgeBasePipeline
    await this._ingestDiscoveryOutputs(sessionId, sortedPainPoints, competitiveAnalysis, direction);

    if (this._shutDown) {
      return {
        sessionId: sessionId,
        painPoints: sortedPainPoints,
        competitiveAnalysis: competitiveAnalysis,
        direction: direction,
        productLensResults: validationResult.productLensResults,
        stats: this._stats,
      };
    }

    const sessionFinal = this._discoverySessions.get(sessionId);
    if (sessionFinal) {
      sessionFinal.completedAt = new Date().toISOString();
    }

    this.emit('opportunity-discovery:discovery-completed', {
      sessionId: sessionId,
      painPointCount: sortedPainPoints.length,
      validatedCount: validationResult.productLensResults.filter(function(r) { return r.passed; }).length,
      hasDirection: direction !== null,
    });

    return {
      sessionId: sessionId,
      painPoints: sortedPainPoints,
      competitiveAnalysis: competitiveAnalysis,
      direction: direction,
      productLensResults: validationResult.productLensResults,
      stats: this._stats,
    };
  }

  /**
   * Validate candidate directions and find the best one.
   * @param {Object[]} candidates - Candidate directions
   * @param {string} sessionId - Session ID for abort check
   * @returns {{productLensResults: Object[], bestDirection: Object|null, bestScore: number}}
   * @private
   */
  _validateCandidates(candidates, sessionId) {
    const productLensResults = [];
    let bestDirection = null;
    let bestScore = -1;

    for (let i = 0; i < candidates.length; i++) {
      if (this._shutDown) return { productLensResults: productLensResults, bestDirection: bestDirection, bestScore: bestScore, aborted: true, sessionId: sessionId };
      const validation = this.validateWithProductLens(candidates[i]);
      productLensResults.push(validation);
      if (validation.passed && validation.scores.overall > bestScore) {
        bestScore = validation.scores.overall;
        bestDirection = candidates[i];
      }
    }

    const session4 = this._discoverySessions.get(sessionId);
    if (session4) {
      session4.validatedCount = productLensResults.filter(function(r) { return r.passed; }).length;
      session4.direction = bestDirection;
    }

    return { productLensResults: productLensResults, bestDirection: bestDirection, bestScore: bestScore };
  }

  /**
   * Ingest discovery outputs into KnowledgeBasePipeline.
   * @param {string} sessionId - Session ID
   * @param {Object[]} painPoints - Pain points
   * @param {Object} competitiveAnalysis - Competitive analysis
   * @param {Object|null} direction - Direction
   * @private
   */
  async _ingestDiscoveryOutputs(sessionId, painPoints, competitiveAnalysis, direction) {
    if (!this._knowledgeBasePipeline || typeof this._knowledgeBasePipeline.ingestRaw !== 'function') return;
    await safeCallAsync(
      function() {
        return this._knowledgeBasePipeline.ingestRaw(
          'discovery/' + sessionId + '/pain-points.json',
          JSON.stringify(painPoints),
          { type: 'pain-points', sessionId: sessionId },
        );
      }.bind(this),
      'OpportunityDiscoveryPipeline', 'ingestDiscovery:painPoints',
    );
    await safeCallAsync(
      function() {
        return this._knowledgeBasePipeline.ingestRaw(
          'discovery/' + sessionId + '/competitive-analysis.json',
          JSON.stringify(competitiveAnalysis),
          { type: 'competitive-analysis', sessionId: sessionId },
        );
      }.bind(this),
      'OpportunityDiscoveryPipeline', 'ingestDiscovery:competitive',
    );
    if (direction) {
      await safeCallAsync(
        function() {
          return this._knowledgeBasePipeline.ingestRaw(
            'discovery/' + sessionId + '/direction.json',
            JSON.stringify(direction),
            { type: 'direction', sessionId: sessionId },
          );
        }.bind(this),
        'OpportunityDiscoveryPipeline', 'ingestDiscovery:direction',
      );
    }
  }

  /**
   * Get collected pain points, optionally filtered by category.
   * @param {string} [category] - Category to filter by
   * @returns {Object[]} Array of pain point objects
   */
  getPainPoints(category) {
    this.guardShutdown();
    const results = [];
    this._painPoints.forEach(function(value, key) {
      if (!category || value.category === category) {
        results.push({ id: key, ...value });
      }
    });
    return results;
  }

  /**
   * Get collected competitor data.
   * @returns {Object[]} Array of competitor objects
   */
  getCompetitors() {
    this.guardShutdown();
    const results = [];
    this._competitors.forEach(function(value, key) {
      results.push({ id: key, ...value });
    });
    return results;
  }

  /**
   * Get collected tech trend data.
   * @returns {Object[]} Array of tech trend objects
   */
  getTechTrends() {
    this.guardShutdown();
    const results = [];
    this._techTrends.forEach(function(value, key) {
      results.push({ id: key, ...value });
    });
    return results;
  }

  /**
   * Get Product Lens validation results, optionally filtered to passed only.
   * @param {boolean} [passedOnly=false] - Whether to return only passed results
   * @returns {Object[]} Array of product lens result objects
   */
  getProductLensResults(passedOnly) {
    this.guardShutdown();
    const results = [];
    this._productLensResults.forEach(function(value, key) {
      if (!passedOnly || value.passed) {
        results.push({ id: key, ...value });
      }
    });
    return results;
  }

  /**
   * Get pipeline statistics.
   * @returns {Object} Statistics object
   */
  getStats() {
    this.guardShutdown();
    return { ...this._stats };
  }

  /**
   * Check if the pipeline is healthy (not shut down and initialized).
   * @returns {boolean} Health status
   */
  isHealthy() {
    return !this._shutDown && this._initialized;
  }

  /**
   * Check if the pipeline is ready (not shut down and initialized).
   * @returns {boolean} Ready status
   */
  isReady() {
    return !this._shutDown && this._initialized;
  }

  /**
   * Clean up all references and maps on shutdown.
   * @private
   */
  _onShutdown() {
    this._browserAdapter = null;
    this._knowledgeBasePipeline = null;
    this._ragPipeline = null;
    this._graphRAG = null;
    this._mcpClient = null;
    this._exaClient = null;
    safeCall(function() { this._painPoints.shutdown(); }.bind(this), 'OpportunityDiscoveryPipeline', 'shutdown:painPoints');
    safeCall(function() { this._competitors.shutdown(); }.bind(this), 'OpportunityDiscoveryPipeline', 'shutdown:competitors');
    safeCall(function() { this._techTrends.shutdown(); }.bind(this), 'OpportunityDiscoveryPipeline', 'shutdown:techTrends');
    safeCall(function() { this._productLensResults.shutdown(); }.bind(this), 'OpportunityDiscoveryPipeline', 'shutdown:productLensResults');
    safeCall(function() { this._discoverySessions.shutdown(); }.bind(this), 'OpportunityDiscoveryPipeline', 'shutdown:discoverySessions');
    this._initialized = false;
    this.removeAllListeners();
  }
}

// --- Private helper functions ---

/**
 * Validate platforms array.
 * @param {*} platforms - Platforms to validate
 * @throws {Error} If platforms is invalid
 * @private
 */
function _validatePlatforms(platforms) {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error('platforms must be a non-empty array');
  }
  const validPlatforms = platforms.filter(function(p) { return SUPPORTED_PLATFORMS.indexOf(p) !== -1; });
  if (validPlatforms.length === 0) {
    throw new Error('platforms must contain at least one supported platform: ' + SUPPORTED_PLATFORMS.join(', '));
  }
}

/**
 * Validate direction object.
 * @param {*} direction - Direction to validate
 * @throws {Error} If direction is invalid
 * @private
 */
function _validateDirection(direction) {
  if (!direction || typeof direction !== 'object') {
    throw new Error('direction must be a non-empty object');
  }
  if (!direction.description || !direction.targetUser || !Array.isArray(direction.painPoints) || !direction.timing) {
    throw new Error('direction must have description, targetUser, painPoints (array), and timing');
  }
}

/**
 * Check unmet criteria for Product Lens validation.
 * @param {number} whoScore - Who score
 * @param {number} howPainful - How painful score
 * @param {number} whyNow - Why now score
 * @param {number} avgSatisfaction - Average satisfaction
 * @param {Object} painData - Aggregated pain data
 * @param {OpportunityDiscoveryPipeline} self - Pipeline instance
 * @returns {string[]} Unmet criteria
 * @private
 */
function _checkUnmetCriteria(whoScore, howPainful, whyNow, avgSatisfaction, painData, self) {
  const unmetCriteria = [];
  if (whoScore < PRODUCT_LENS_MIN_SCORE) { unmetCriteria.push('who'); }
  if (howPainful < PRODUCT_LENS_MIN_SCORE) { unmetCriteria.push('howPainful'); }
  if (howPainful < self._painIntensityThreshold) { unmetCriteria.push('painIntensityThreshold'); }
  if (whyNow < PRODUCT_LENS_MIN_SCORE) { unmetCriteria.push('whyNow'); }
  if (avgSatisfaction > self._solutionSatisfactionThreshold) { unmetCriteria.push('solutionSatisfactionThreshold'); }
  if (painData.count > 0 && painData.sourcesCount / painData.count < self._minSourcesPerPainPoint) { unmetCriteria.push('minSourcesPerPainPoint'); }
  return unmetCriteria;
}

/**
 * Extract text content from a data item.
 * @param {Object} item - Data item
 * @returns {string} Extracted text
 * @private
 */
function _extractText(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  if (item.content) return String(item.content);
  if (item.text) return String(item.text);
  if (item.title) return String(item.title);
  if (item.body) return String(item.body);
  try { return JSON.stringify(item).slice(0, 500); } catch (_e) { debug('OpportunityDiscoveryPipeline', 'stringify', _e && _e.message ? _e.message : String(_e)); return String(item).slice(0, 500); }
}

/**
 * Classify text as complaint or non-complaint based on keyword patterns.
 * @param {string} text - Text to classify
 * @returns {{isComplaint: boolean, intensity: number, matchedKeywords: string[]}}
 * @private
 */
function _classifyText(text) {
  if (!text || typeof text !== 'string') {
    return { isComplaint: false, intensity: 0, matchedKeywords: [] };
  }
  const lower = text.toLowerCase();
  const matchedKeywords = [];

  for (let i = 0; i < COMPLAINT_KEYWORDS.length; i++) {
    if (lower.indexOf(COMPLAINT_KEYWORDS[i]) !== -1) {
      matchedKeywords.push(COMPLAINT_KEYWORDS[i]);
    }
  }

  for (let i = 0; i < NON_COMPLAINT_KEYWORDS.length; i++) {
    if (lower.indexOf(NON_COMPLAINT_KEYWORDS[i]) !== -1) {
      return { isComplaint: false, intensity: 0, matchedKeywords: [] };
    }
  }

  if (matchedKeywords.length === 0) {
    return { isComplaint: false, intensity: 0, matchedKeywords: [] };
  }

  const intensityScore = _calculateIntensity(lower, matchedKeywords);
  const intensity = Math.min(10, Math.round(intensityScore * 10) / 10);

  return { isComplaint: true, intensity: intensity, matchedKeywords: matchedKeywords };
}

/**
 * Calculate intensity score from text and matched keywords.
 * @param {string} lower - Lowercased text
 * @param {string[]} matchedKeywords - Matched complaint keywords
 * @returns {number} Intensity score
 * @private
 */
function _calculateIntensity(lower, matchedKeywords) {
  let intensityScore = 0;
  for (let i = 0; i < HIGH_INTENSITY_WORDS.length; i++) {
    if (lower.indexOf(HIGH_INTENSITY_WORDS[i]) !== -1) { intensityScore += 3; }
  }
  for (let i = 0; i < MEDIUM_INTENSITY_WORDS.length; i++) {
    if (lower.indexOf(MEDIUM_INTENSITY_WORDS[i]) !== -1) { intensityScore += 2; }
  }
  intensityScore += Math.max(0, matchedKeywords.length - intensityScore / 2);
  return intensityScore;
}

/**
 * Extract tech signals (edge cases and opportunities) from text.
 * @param {string} text - Text to analyze
 * @param {string[]} edgeCases - Array to push edge cases into
 * @param {string[]} opportunities - Array to push opportunities into
 * @private
 */
function _extractTechSignals(text, edgeCases, opportunities) {
  if (!text) return;
  const edgeMatch = text.match(/edge\s+case|limitation|corner\s+case|unexpected|surprising|breaking\s+change|deprecation|migration/i);
  if (edgeMatch) { edgeCases.push(text.slice(0, 200)); }
  const oppMatch = text.match(/new\s+(application|use\s+case|possibility|opportunity)|could\s+be\s+used|potential\s+for|new\s+release|v\d+\.\d+\.\d+|beta|alpha|preview/i);
  if (oppMatch) { opportunities.push(text.slice(0, 200)); }
}

/**
 * Group similar complaints by keyword overlap.
 * @param {Object[]} complaints - Array of complaint objects
 * @returns {Array<Object[]>} Groups of similar complaints
 * @private
 */
function _groupComplaints(complaints) {
  if (complaints.length === 0) return [];
  const groups = [];
  const assigned = new Array(complaints.length).fill(false);

  for (let i = 0; i < complaints.length; i++) {
    if (assigned[i]) continue;
    const group = [complaints[i]];
    assigned[i] = true;

    for (let j = i + 1; j < complaints.length; j++) {
      if (assigned[j]) continue;
      const overlap = _keywordOverlap(complaints[i].keywords, complaints[j].keywords);
      if (overlap >= 0.3) {
        group.push(complaints[j]);
        assigned[j] = true;
      }
    }

    groups.push(group);
  }

  return groups;
}

/**
 * Calculate keyword overlap ratio between two keyword arrays.
 * @param {string[]} a - First keyword array
 * @param {string[]} b - Second keyword array
 * @returns {number} Overlap ratio (0-1)
 * @private
 */
function _keywordOverlap(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a.map(function(k) { return k.toLowerCase(); }));
  const setB = new Set(b.map(function(k) { return k.toLowerCase(); }));
  let intersection = 0;
  setA.forEach(function(k) { if (setB.has(k)) intersection++; });
  return intersection / Math.max(setA.size, setB.size);
}

/**
 * Calculate average intensity from a group of complaints.
 * @param {Object[]} group - Array of complaint objects
 * @returns {number} Average intensity
 * @private
 */
function _averageIntensity(group) {
  if (group.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < group.length; i++) {
    sum += group[i].intensity ?? 0;
  }
  return Math.round((sum / group.length) * 10) / 10;
}

/**
 * Infer satisfaction level from complaint language.
 * @param {Object[]} group - Array of complaint objects
 * @returns {number} Inferred satisfaction (1-10, lower = less satisfied)
 * @private
 */
function _inferSatisfaction(group) {
  if (group.length === 0) return 5;
  const avgIntensity = _averageIntensity(group);
  return Math.max(1, Math.round(10 - avgIntensity));
}

/**
 * Infer category from complaint keywords.
 * @param {Object[]} group - Array of complaint objects
 * @returns {string} Inferred category
 * @private
 */
function _inferCategory(group) {
  const allText = group.map(function(c) { return (c.text || '').toLowerCase(); }).join(' ');
  return _matchCategory(allText);
}

/**
 * Match text against category patterns.
 * @param {string} text - Combined lowercased text
 * @returns {string} Category name
 * @private
 */
function _matchCategory(text) {
  if (_hasAnyWord(text, ['price', 'cost', 'expensive'])) return 'pricing';
  if (_hasAnyWord(text, ['performance', 'slow', 'speed'])) return 'performance';
  if (_hasAnyWord(text, ['feature', 'wish', 'missing'])) return 'feature-gap';
  if (_hasAnyWord(text, ['ux', 'ui', 'interface', '难用'])) return 'usability';
  if (_hasAnyWord(text, ['bug', 'broken', 'crash', '崩溃'])) return 'reliability';
  if (_hasAnyWord(text, ['support', 'help', 'service'])) return 'support';
  return 'general';
}

/**
 * Check if text contains any of the given words.
 * @param {string} text - Text to check
 * @param {string[]} words - Words to look for
 * @returns {boolean} Whether any word was found
 * @private
 */
function _hasAnyWord(text, words) {
  for (let i = 0; i < words.length; i++) {
    if (text.indexOf(words[i]) !== -1) return true;
  }
  return false;
}

/**
 * Score target user specificity.
 * @param {string} targetUser - Target user description
 * @returns {number} Score 0-10
 * @private
 */
function _scoreTargetUser(targetUser) {
  if (!targetUser || typeof targetUser !== 'string') return 0;
  const len = targetUser.trim().length;
  if (len === 0) return 0;
  const hasQuantifier = /\d+/.test(targetUser);
  const hasPersona = /developer|engineer|manager|designer|analyst|student|teacher|creator|founder|团队|开发者|工程师|设计师/i.test(targetUser);
  const isVague = len < 15 || /^(anyone|everyone|users?|people|all|用户)$/i.test(targetUser.trim());

  if (isVague) return 2;
  if (hasPersona && hasQuantifier) return 10;
  if (hasQuantifier) return 8;
  if (hasPersona) return 5;
  if (len > 30) return 5;
  return 3;
}

/**
 * Score timing based on market window, tech maturity, and competitive landscape.
 * @param {Object} timing - Timing context
 * @returns {number} Score 0-10
 * @private
 */
function _scoreTiming(timing) {
  if (!timing || typeof timing !== 'object') return 0;
  let score = 0;
  if (timing.marketWindow) { score += 3; }
  if (timing.techMaturity) { score += 3; }
  if (timing.competitiveLandscape) { score += 3; }
  if (timing.urgency) { score += 1; }
  return Math.min(10, score);
}

/**
 * Extract rating from a review item.
 * @param {Object} item - Review item
 * @returns {number} Rating (0 if not found)
 * @private
 */
function _extractRating(item) {
  if (!item) return 0;
  if (typeof item.rating === 'number') return item.rating;
  if (typeof item.score === 'number') return item.score / 10;
  const text = _extractText(item);
  const match = text.match(/(\d(?:\.\d)?)\s*\/\s*5/);
  if (match) { const n = parseFloat(match[1]); return Number.isFinite(n) ? n * 2 : 0; }
  return 0;
}

/**
 * Extract date from a data item.
 * @param {Object} item - Data item
 * @returns {Date|null} Extracted date or null
 * @private
 */
function _extractDate(item) {
  if (!item) return null;
  const dateStr = item.date || item.publishedAt || item.publishTime;
  if (typeof dateStr === 'string') {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Update average statistics.
 * @param {OpportunityDiscoveryPipeline} self - Pipeline instance
 * @private
 */
function _updateAvgStats(self) {
  let totalIntensity = 0;
  let totalSources = 0;
  let count = 0;
  self._painPoints.forEach(function(value) {
    totalIntensity += value.intensity ?? 0;
    totalSources += value.sources ? value.sources.length : 0;
    count++;
  });
  self._stats.avgPainIntensity = count > 0 ? Math.round((totalIntensity / count) * 10) / 10 : 0;
  self._stats.avgSourcesPerPainPoint = count > 0 ? Math.round((totalSources / count) * 10) / 10 : 0;
}

/**
 * Extract competitor names from pain points.
 * @param {Object[]} painPoints - Array of pain point objects
 * @returns {string[]} Competitor names
 * @private
 */
function _extractCompetitorNames(painPoints) {
  const names = new Set();
  for (let i = 0; i < painPoints.length; i++) {
    const desc = (painPoints[i].description || '').toLowerCase();
    const match = desc.match(/alternative\s+to\s+(\w+)|switch\s+from\s+(\w+)|vs\.?\s+(\w+)|compete\s+with\s+(\w+)/i);
    if (match) {
      for (let j = 1; j < match.length; j++) {
        if (match[j]) names.add(match[j]);
      }
    }
  }
  return Array.from(names).slice(0, 10);
}

/**
 * Extract technologies from pain points.
 * @param {Object[]} painPoints - Array of pain point objects
 * @returns {string[]} Technology names
 * @private
 */
function _extractTechnologies(painPoints) {
  const techs = new Set();
  const techPatterns = /\b(ai|ml|llm|gpt|claude|rust|go|python|typescript|kubernetes|docker|serverless|edge\s*computing|wasm|webassembly)\b/gi;
  for (let i = 0; i < painPoints.length; i++) {
    const desc = painPoints[i].description || '';
    let match;
    while ((match = techPatterns.exec(desc)) !== null) {
      techs.add(match[1].toLowerCase());
    }
  }
  return Array.from(techs).slice(0, 10);
}

/**
 * Build candidate directions from discovery results.
 * @param {Object[]} painPoints - Pain points
 * @param {Object} competitiveResult - Competitive analysis results
 * @param {Object} techResult - Tech dividend results
 * @returns {Object[]} Candidate directions
 * @private
 */
function _buildCandidateDirections(painPoints, competitiveResult, techResult, pipeline) {
  const directions = [];
  const topPainPoints = painPoints.slice(0, 5);
  const persona = pipeline ? pipeline._generatePersona(painPoints, competitiveResult.competitors) : null;

  for (let i = 0; i < topPainPoints.length; i++) {
    const pp = topPainPoints[i];
    if (!pp.validated) continue;
    const targetUser = persona
      ? persona.primarySegment + ' (' + persona.techSavviness + ' tech savviness, ' + persona.budgetHint + ')'
      : 'Users experiencing: ' + pp.description.slice(0, 60);
    directions.push({
      description: pp.description,
      targetUser: targetUser,
      painPoints: [pp],
      timing: {
        marketWindow: pp.frequency >= 3,
        techMaturity: techResult.techTrends.length > 0,
        competitiveLandscape: competitiveResult.uniqueGaps.length > 0,
        urgency: pp.intensity >= 8,
      },
      persona: persona || undefined,
    });
  }

  if (competitiveResult.uniqueGaps.length > 0 && topPainPoints.length > 0) {
    const gapTargetUser = persona
      ? persona.primarySegment + ' underserved by existing solutions'
      : 'Users underserved by existing solutions';
    directions.push({
      description: 'Address ' + competitiveResult.uniqueGaps[0] + ' gap identified in competitive analysis',
      targetUser: gapTargetUser,
      painPoints: topPainPoints.slice(0, 2),
      timing: {
        marketWindow: true,
        techMaturity: techResult.techTrends.length > 0,
        competitiveLandscape: true,
        urgency: true,
      },
      persona: persona || undefined,
    });
  }

  return directions;
}

/**
 * Generate one-sentence direction description using richer template.
 * "For [target user] solving [core pain], through [key differentiation], within [time window] capturing [market gap]"
 * @param {Object} direction - Validated direction
 * @param {number} score - Overall score
 * @returns {string} One-sentence direction
 * @private
 */
function _generateOneSentenceDirection(direction, score) {
  const target = direction.targetUser || 'underserved users';
  const pain = direction.description ? direction.description.slice(0, 80) : 'an unmet need';

  // Derive key differentiation from unique gaps
  const uniqueGaps = direction.uniqueGaps ?? [];
  const keyDifferentiation = uniqueGaps.length > 0
    ? 'addressing ' + uniqueGaps.slice(0, 2).join(' and ') + ' gaps'
    : 'a differentiated approach';

  // Derive time window from timing score
  const timingScore = score ?? 0;
  let timeWindow = 'long-term';
  if (timingScore >= 8) timeWindow = 'immediate window';
  else if (timingScore >= 6) timeWindow = 'near-term';

  // Derive market gap from gap matrix
  const gapMatrix = direction.gapMatrix ?? {};
  const gapCount = Object.keys(gapMatrix).length;
  const marketGap = gapCount > 0
    ? gapCount + ' competitor gap' + (gapCount > 1 ? 's' : '')
    : 'emerging opportunity';

  return 'For ' + target + ' solving ' + pain + ', through ' + keyDifferentiation + ', within ' + timeWindow + ' capturing ' + marketGap + '.';
}

module.exports = withShutdown(OpportunityDiscoveryPipeline);
Object.assign(module.exports, {
  MIN_SOURCES_PER_PAIN_POINT: 5,
  PAIN_INTENSITY_THRESHOLD: 7,
  SOLUTION_SATISFACTION_THRESHOLD: 4,
  COMPETITOR_REVIEW_MIN_COUNT: 20,
  TECH_TREND_RECENCY_DAYS: 90,
  MIN_FEATURE_REQUEST_VOTES: 10,
  MAX_PAIN_POINTS: 200,
  MAX_COMPETITORS: 50,
  MAX_TECH_TRENDS: 100,
  MAX_PRODUCT_LENS_RESULTS: 50,
  MAX_DISCOVERY_SESSIONS: 30,
  COMPLAINT_KEYWORDS: COMPLAINT_KEYWORDS,
  PRODUCT_LENS_MIN_SCORE: PRODUCT_LENS_MIN_SCORE,
  SUPPORTED_PLATFORMS: SUPPORTED_PLATFORMS,
  TECH_SOURCES: TECH_SOURCES,
});
