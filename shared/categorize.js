/**
 * Rules-based categorization.
 *
 * Classifies a bookmark from its URL and title alone, using a shipped data
 * map (rules-data.json). This is tier 1 of the architecture: instant, free,
 * no API key, and enough to render the whole Library Report. Tier 2 (AI) is
 * explicitly out of scope for Milestone 1.
 *
 * Matching order is fixed and deterministic: exact domain, then URL phrase,
 * then title phrase. The first rule that matches wins. When nothing matches,
 * a single neutral fallback category is returned.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./normalize'), require('./constants'));
  } else {
    root.BRCategorize = factory(root.BRNormalize, root.BRConstants);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (normalize, constants) {
  'use strict';

  var DEFAULT_CATEGORY = constants.DEFAULT_CATEGORY;
  var CATEGORY_SOURCE = constants.CATEGORY_SOURCE;
  var CATEGORY_CONFIDENCE = constants.CATEGORY_CONFIDENCE;

  function phrasedIncludes(lowerPhrase, lowerTarget) {
    return lowerTarget.indexOf(lowerPhrase) !== -1;
  }

  /**
   * Classify one bookmark item.
   * @param {object} item  { url, title }
   * @param {object} rules the parsed rules-data.json
   * @param {object} opts optional { includeSource:true } to also return the
   *   matched key for diagnostics.
   * @returns {{category:string, source:string, confidence:number, match?: string}}
   */
  function categorize(item, rules, opts) {
    opts = opts || {};
    var fallbackRules = rules && rules.fallback ? rules.fallback : DEFAULT_CATEGORY;

    if (!item || typeof item.url !== 'string') {
      return {
        category: defaultCategoryCode(fallbackRules),
        source: CATEGORY_SOURCE,
        confidence: 0
      };
    }

    var domain = normalize.extractDomain(item.url);
    var urlLower = item.url.toLowerCase();
    var titleLower = typeof item.title === 'string' ? item.title.toLowerCase() : '';

    var domains = (rules && rules.domains) || {};
    if (domain && Object.prototype.hasOwnProperty.call(domains, domain)) {
      return makeResult(domains[domain], 'domain', domain, opts);
    }

    var urlPhrases = (rules && rules.urlPhrases) || [];
    for (var i = 0; i < urlPhrases.length; i++) {
      var u = urlPhrases[i];
      if (u && u.phrase && phrasedIncludes(u.phrase.toLowerCase(), urlLower)) {
        return makeResult(u.category, 'urlPhrase', u.phrase, opts);
      }
    }

    var titlePhrases = (rules && rules.titlePhrases) || [];
    for (var j = 0; j < titlePhrases.length; j++) {
      var t = titlePhrases[j];
      if (t && t.phrase && phrasedIncludes(t.phrase.toLowerCase(), titleLower)) {
        return makeResult(t.category, 'titlePhrase', t.phrase, opts);
      }
    }

    return {
      category: fallbackRules,
      source: CATEGORY_SOURCE,
      confidence: 0
    };
  }

  function makeResult(category, source, matched, opts) {
    var res = {
      category: category,
      source: CATEGORY_SOURCE,
      confidence: CATEGORY_CONFIDENCE
    };
    if (opts && opts.includeSource) {
      res.matchKey = source;
      res.matched = matched;
    }
    return res;
  }

  function defaultCategoryCode(fallback) {
    return fallback;
  }

  return {
    categorize: categorize
  };
});
