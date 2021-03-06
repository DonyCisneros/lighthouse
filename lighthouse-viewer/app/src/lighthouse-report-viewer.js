/**
 * @license Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/* global DOM, CategoryRenderer, DetailsRenderer, ViewerUIFeatures, ReportRenderer, DragAndDrop, GithubApi, logger */

/**
 * Class that manages viewing Lighthouse reports.
 */
class LighthouseReportViewer {
  constructor() {
    this._onPaste = this._onPaste.bind(this);
    this._onSaveJson = this._onSaveJson.bind(this);
    this._onFileLoad = this._onFileLoad.bind(this);
    this._onUrlInputChange = this._onUrlInputChange.bind(this);

    this._dragAndDropper = new DragAndDrop(this._onFileLoad);
    this._github = new GithubApi();

    /**
     * Used for tracking whether to offer to upload as a gist.
     * @private {boolean}
     */
    this._reportIsFromGist = false;

    this._addEventListeners();
    this._loadFromDeepLink();
    this._listenForMessages();
  }

  static get APP_URL() {
    return `${location.origin}${location.pathname}`;
  }

  /**
   * Initialize event listeners.
   * @private
   */
  _addEventListeners() {
    document.addEventListener('paste', this._onPaste);

    const gistUrlInput = document.querySelector('.js-gist-url');
    gistUrlInput.addEventListener('change', this._onUrlInputChange);

    // Hidden file input to trigger manual file selector.
    const fileInput = document.querySelector('#hidden-file-input');
    fileInput.addEventListener('change', e => {
      this._onFileLoad(e.target.files[0]);
      e.target.value = null;
    });

    // A click on the visual placeholder will trigger the hidden file input.
    const placeholderTarget = document.querySelector('.viewer-placeholder-inner');
    placeholderTarget.addEventListener('click', e => {
      if (e.target.localName !== 'input') {
        fileInput.click();
      }
    });
  }

  /**
   * Attempts to pull gist id from URL and render report from it.
   * @return {!Promise<undefined>}
   * @private
   */
  _loadFromDeepLink() {
    const params = new URLSearchParams(location.search);
    const gistId = params.get('gist');
    if (!gistId) {
      return Promise.resolve();
    }

    return this._github.getGistFileContentAsJson(gistId).then(reportJson => {
      this._reportIsFromGist = true;
      this._replaceReportHtml(reportJson);
    }).catch(err => logger.error(err.message));
  }

  /**
   * Basic Lighthouse report JSON validation.
   * @param {!ReportRenderer.ReportJSON} reportJson
   * @private
   */
  _validateReportJson(reportJson) {
    if (!reportJson.lighthouseVersion) {
      throw new Error('JSON file was not generated by Lighthouse');
    }

    // Leave off patch version in the comparison.
    const semverRe = new RegExp(/^(\d+)?\.(\d+)?\.(\d+)$/);
    const reportVersion = reportJson.lighthouseVersion.replace(semverRe, '$1.$2');
    const lhVersion = window.LH_CURRENT_VERSION.replace(semverRe, '$1.$2');

    if (reportVersion < lhVersion) {
      // TODO: figure out how to handler older reports. All permalinks to older
      // reports will start to throw this warning when the viewer rev's its
      // minor LH version.
      // See https://github.com/GoogleChrome/lighthouse/issues/1108
      logger.warn('Results may not display properly.\n' +
                  'Report was created with an earlier version of ' +
                  `Lighthouse (${reportJson.lighthouseVersion}). The latest ` +
                  `version is ${window.LH_CURRENT_VERSION}.`);
    }
  }

  /**
   * @param {!ReportRenderer.ReportJSON} json
   * @private
   */
  _replaceReportHtml(json) {
    this._validateReportJson(json);

    const dom = new DOM(document);
    const detailsRenderer = new DetailsRenderer(dom);
    const categoryRenderer = new CategoryRenderer(dom, detailsRenderer);
    const renderer = new ReportRenderer(dom, categoryRenderer);

    const container = document.querySelector('main');
    try {
      renderer.renderReport(json, container);

      // Only give gist-saving callback (and clear gist from query string) if
      // current report isn't from a gist.
      let saveCallback = null;
      if (!this._reportIsFromGist) {
        saveCallback = this._onSaveJson;
        history.pushState({}, null, LighthouseReportViewer.APP_URL);
      }

      const features = new ViewerUIFeatures(dom, saveCallback);
      features.initFeatures(json);
    } catch (e) {
      logger.error(`Error rendering report: ${e.message}`);
      dom.resetTemplates(); // TODO(bckenny): hack
      container.textContent = '';
      throw e;
    }

    // Remove the placeholder UI once the user has loaded a report.
    const placeholder = document.querySelector('.viewer-placeholder');
    if (placeholder) {
      placeholder.remove();
    }

    if (window.ga) {
      window.ga('send', 'event', 'report', 'view');
    }
  }

  /**
   * Updates the page's HTML with contents of the JSON file passed in.
   * @param {!File} file
   * @return {!Promise<undefined>}
   * @throws file was not valid JSON generated by Lighthouse or an unknown file
   *     type was used.
   * @private
   */
  _onFileLoad(file) {
    return this._readFile(file).then(str => {
      let json;
      try {
        json = JSON.parse(str);
      } catch (e) {
        throw new Error('Could not parse JSON file.');
      }

      this._reportIsFromGist = false;
      this._replaceReportHtml(json);
    }).catch(err => logger.error(err.message));
  }

  /**
   * Reads a file and returns its content as a string.
   * @param {!File} file
   * @return {!Promise<string>}
   * @private
   */
  _readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new window.FileReader();
      reader.onload = function(e) {
        resolve(e.target.result);
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  /**
   * Saves the current report by creating a gist on GitHub.
   * @param {!ReportRenderer.ReportJSON} reportJson
   * @return {!Promise<string>} id of the created gist.
   * @private
   */
  _onSaveJson(reportJson) {
    if (window.ga) {
      window.ga('send', 'event', 'report', 'share');
    }

    // TODO: find and reuse existing json gist if one exists.
    return this._github.createGist(reportJson).then(id => {
      if (window.ga) {
        window.ga('send', 'event', 'report', 'created');
      }

      this._reportIsFromGist = true;
      history.pushState({}, null, `${LighthouseReportViewer.APP_URL}?gist=${id}`);

      return id;
    }).catch(err => logger.log(err.message));
  }

  /**
   * Enables pasting a JSON report or gist URL on the page.
   * @private
   */
  _onPaste(e) {
    e.preventDefault();

    // Try paste as gist URL.
    try {
      const url = new URL(e.clipboardData.getData('text'));
      this._loadFromGistURL(url);

      if (window.ga) {
        window.ga('send', 'event', 'report', 'paste-link');
      }
    } catch (err) {
      // noop
    }

    // Try paste as json content.
    try {
      const json = JSON.parse(e.clipboardData.getData('text'));
      this._reportIsFromGist = false;
      this._replaceReportHTML(json);

      if (window.ga) {
        window.ga('send', 'event', 'report', 'paste');
      }
    } catch (err) {
      // noop
    }
  }

  /**
   * Handles changes to the gist url input.
   * @private
   */
  _onUrlInputChange(e) {
    e.stopPropagation();

    if (!e.target.value) {
      return;
    }

    try {
      this._loadFromGistURL(e.target.value);
    } catch (err) {
      logger.error('Invalid URL');
    }
  }

  /**
   * Loads report json from gist URL, if valid. Updates page URL with gist ID
   * and loads from github.
   * @param {string} url Gist URL.
   * @private
   */
  _loadFromGistURL(url) {
    try {
      url = new URL(url);

      if (url.origin !== 'https://gist.github.com') {
        logger.error('URL was not a gist');
        return;
      }

      const match = url.pathname.match(/[a-f0-9]{5,}/);
      if (match) {
        history.pushState({}, null, `${LighthouseReportViewer.APP_URL}?gist=${match[0]}`);
        this._loadFromDeepLink();
      }
    } catch (err) {
      logger.error('Invalid URL');
    }
  }

  /**
   * Initializes of a `message` listener to respond to postMessage events.
   * @private
   */
  _listenForMessages() {
    window.addEventListener('message', e => {
      if (e.source === self.opener && e.data.lhresults) {
        this._reportIsFromGist = false;
        this._replaceReportHtml(e.data.lhresults);
        if (window.ga) {
          window.ga('send', 'event', 'report', 'open in viewer');
        }
      }
    });

    // If the page was opened as a popup, tell the opening window we're ready.
    if (self.opener && !self.opener.closed) {
      self.opener.postMessage({opened: true}, '*');
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LighthouseReportViewer;
}
