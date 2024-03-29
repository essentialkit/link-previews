import { Logger } from "../utils/logger";
import { WinBox } from "../utils/winbox/winbox";
import "./previewr.css";
import { sanitizeUrl } from "@braintree/sanitize-url";
import { Readability } from "@mozilla/readability";
import "../utils/feedback/feedback";
import { FeedbackData } from "../background-script/feedback-checker";
import { FEEDBACK_DATA_KEY } from "../utils/storage";
import Storage from "../utils/storage";
import Analytics from "../utils/analytics";
import manifest from "../manifest.json";

const iframeName = manifest.__package_name__ + "/mainframe";
// Override the #setUrl method to set name attribute on iframe.
WinBox.prototype.setUrl = function (url, onload) {
  const node = this.body.firstChild;

  if (node && node.tagName.toLowerCase() === "iframe") {
    node.src = url;
  } else {
    this.body.innerHTML =
      '<iframe name="' + iframeName + '" src="' + url + '"></iframe>';
    onload && (this.body.firstChild.onload = onload);
  }

  return this;
};

// This class is responsible to loading/reloading/unloading the angular app into the UI.
export class Previewr {
  logger = new Logger(this);
  headerIconUrlBase = "https://www.google.com/s2/favicons?domain=";
  dialog?: WinBox;
  isVisible = false;
  url?: URL;
  navStack: URL[] = [];
  displayReaderMode = false;
  isDemo = false;
  searchUrl = {
    google: "https://www.google.com/search?igu=1&q=",
    bing: "https://www.bing.com/search?q=",
    yahoo: "https://search.yahoo.com/search?p=",
    baidu: "https://www.baidu.com/s?wd=",
    yandex: "https://yandex.com/search/?text=",
    duckduckgo: "https://duckduckgo.com/?q=",
    ecosia: "https://www.ecosia.org/search?q=",
  };

  /* This function inserts an Angular custom element (web component) into the DOM. */
  init() {
    if (this.inIframe()) {
      this.logger.log(
        "Not inserting previewr in iframe: ",
        window.location.href,
      );
      return;
    }

    this.listenForCspError();
    this.listenForWindowMessages();
    document.addEventListener("keydown", this.onEscHandler);
    document.addEventListener("click", (e) => this.clickHandler(e));
    document.addEventListener("scroll", (e) => this.handleScroll(e));
  }

  listenForCspError() {
    document.addEventListener("securitypolicyviolation", (e) => {
      if (window.name !== iframeName) {
        return;
      }
      this.logger.error("CSP error", e, e.blockedURI);
    });
  }

  onEscHandler = (evt) => {
    evt = evt || window.event;
    var isEscape = false;
    if ("key" in evt) {
      isEscape = evt.key === "Escape" || evt.key === "Esc";
    } else {
      isEscape = evt.keyCode === 27;
    }
    if (isEscape) {
      this.handleMessage({
        action: "escape",
        href: document.location.href,
        sourceFrame: iframeName,
      });
    }
  };

  // Close the dialog preview on click outside of the preview panel, when automatically-hide-previews is enabled.
  async clickHandler(e) {
    const autoHide =
      (await Storage.get("automatically-hide-previews")) ?? false;
    if (autoHide && this.dialog && !this.dialog.dom.contains(e.target)) {
      this.dialog.close();
    }
  }

  // Close the dialog preview on scroll outside of the preview panel, when automatically-hide-previews is enabled.
  async handleScroll(e) {
    const autoHide =
      (await Storage.get("automatically-hide-previews")) ?? false;
    if (autoHide && this.dialog && !this.dialog.dom.contains(e.target)) {
      this.dialog.close();
    }
  }

  listenForWindowMessages() {
    window.addEventListener(
      "message",
      (event) => {
        if (event.origin !== window.location.origin) {
          this.logger.debug(
            "Ignoring message from different origin",
            event.origin,
            event.data,
          );
          return;
        }

        if (event.data.application !== manifest.__package_name__) {
          this.logger.debug(
            "Ignoring origin messsage not initiated by Better Previews",
            event.data,
          );
          return;
        }

        this.logger.log("#WindowMessage: ", event);
        this.handleMessage(event.data);
      },
      false,
    );
  }

  async handleMessage(message) {
    // Extract the url from the message.
    let urlStr;
    if (message.mode === "demo") {
      this.isDemo = true;
    }

    if (message.action === "copy") {
      navigator.clipboard.writeText(message.data);
      return;
    } else if (message.action === "preview") {
      urlStr = message.data;
    } else if (message.action === "search") {
      const searchEngine = (await Storage.get("search-engine")) ?? "google";
      urlStr = this.searchUrl[searchEngine] + message.data;

      // Add override for google search without incognito.
      if (searchEngine === "google") {
        const disableIncognitoGoogle = await Storage.get(
          "disable-incognito-google",
        );
        if (disableIncognitoGoogle == true) {
          urlStr = "https://www.google.com/search?q=" + message.data;
        }
      }
    } else if (message.action === "load") {
      if (message.sourceFrame === iframeName && this.dialog) {
        this.dialog.setTitle(message.data.title);
        this.dialog.setIcon(
          this.headerIconUrlBase + new URL(message.href!).hostname,
        );
      }
    } else if (message.action === "navigate") {
      urlStr = message.href;
    } else if (message.action === "escape") {
      const closeOnEsc = (await Storage.get("close-on-esc")) ?? true;
      if (closeOnEsc) {
        this.dialog?.close();
      }
      return;
    } else {
      this.logger.warn("Unhandled action", message);
    }

    // Ensure it is valid.
    if (!urlStr || sanitizeUrl(urlStr) === "about:blank") {
      return;
    }
    let newUrl;
    try {
      newUrl = new URL(urlStr);
    } catch (e) {
      this.logger.error(e);
      return;
    }

    // Move the old URL to backstack.
    if (this.url && this.url.href !== newUrl.href) {
      this.navStack.push(this.url);
    }

    // Preview new URL.
    return this.previewUrl(newUrl);
  }

  async previewUrl(url: URL) {
    this.logger.log("#previewUrl: ", url);
    this.url = url;

    const winboxOptions = await this.getWinboxOptions(url);

    if (this.displayReaderMode) {
      let reader = new Readability(window.document.cloneNode(true) as Document);
      let article = reader.parse();
      if (!article) {
        console.error("Article is null");
        winboxOptions.html = `<h1>Failed to parse article</h1>`;
      }
      winboxOptions.html = `<h1>${article.title}</h1> <p>${article.byline}</p> ${article.content}`;
    } else {
      winboxOptions.url = this.url;
    }

    if (!this.dialog) {
      this.logger.debug("creating new dialog with options:", winboxOptions);
      this.dialog = new WinBox(url.hostname, winboxOptions);

      this.dialog.addControl({
        index: 2,
        class: "wb-nav-away",
        title: "Open in New Tab",
        image: "",
        click: (event, winbox) => {
          this.logger.log("#onOpenInNewTab: url", this.url);
          window.open(this.url, "_blank");
        },
      });
      this.dialog.addControl({
        index: 3,
        class: "wb-settings",
        title: "Extension Settings",
        image: "",
        click: (event, winbox) => {
          this.logger.log("#onOpenSettings: url", this.url);
          chrome.runtime.sendMessage("open_options_page");
        },
      });
    } else {
      this.logger.debug("restoring dialog");
      this.dialog.restore();
      this.dialog.setUrl(url.href);
      this.dialog.setTitle(url.hostname);
      this.dialog.setIcon(this.headerIconUrlBase + url.hostname);
    }

    this.dialog.removeControl("nav-back");
    if (this.navStack.length > 0) {
      this.dialog.addControl({
        index: 0,
        class: "nav-back",
        image: "",
        title: "Go Back",
        click: (event, winbox) => {
          this.navBack();
        },
      });
    }

    await this.registerFeedbackUI();
  }

  async registerFeedbackUI() {
    const feedbackData: FeedbackData | null =
      await Storage.get(FEEDBACK_DATA_KEY);
    const shouldShow = feedbackData?.status === "eligible";
    if (shouldShow) {
      this.dialog?.addClass("show-footer");
    }

    // Listen for component events.
    const ff = this.dialog?.dom.querySelector("feedback-form");
    ff.setProgressHandler((status, data) => {
      if (status === "started") {
        this.logger.log("started: this", this, chrome?.storage?.sync);
        const feedbackUpdate: FeedbackData = {
          status: "honored",
          timestamp: Date.now(),
          rating: data,
        };
        Storage.put(FEEDBACK_DATA_KEY, feedbackUpdate);

        Analytics.fireEvent("user_feedback", {
          action: "rate_experience",
          star_rating: data,
        });
      }

      if (status === "completed") {
        this.dialog?.removeClass("show-footer");
        Analytics.fireEvent("user_feedback", {
          action: "submit_feedback",
          feedback_text: data,
        });
      }
    });
  }

  navBack() {
    const lastUrl = this.navStack.pop();
    if (lastUrl) {
      this.previewUrl(lastUrl);
    }
  }

  /*
   * Returns true if this script is running inside an iframe,
   * since the content script is added to all frames.
   */
  inIframe() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true;
    }
  }

  getMaxZIndex() {
    return new Promise((resolve: (arg0: number) => void) => {
      const z = Math.max(
        ...Array.from(document.querySelectorAll("body *"), (el) =>
          parseFloat(window.getComputedStyle(el).zIndex),
        ).filter((zIndex) => !Number.isNaN(zIndex)),
        0,
      );
      resolve(z);
    });
  }

  async getWinboxOptions(url: URL, point?: DOMRect) {
    // Set width and height from options if present.
    let width = ((await Storage.get("previewr-width")) ?? "55") + "%";
    let height = ((await Storage.get("previewr-height")) ?? "80") + "%";
    let ltr = (await Storage.get("previewr-position")) ?? "right";

    // Leave space on top for headers/navigation.
    let top = "80px";

    // In demo mode, use small width and height, and push down previewr.
    if (this.isDemo) {
      width = "45%";
      height = "40%";
      top = "500px";
    }
    let options: any = {
      icon: this.headerIconUrlBase + url.hostname,
      y: top,
      width: width,
      height: height,
      class: ["no-max", "no-full"],
      index: await this.getMaxZIndex(),
      hidden: false,
      shadowel: "search-preview-window",
      framename: iframeName,

      onclose: () => {
        this.navStack = [];
        this.url = undefined;
        this.dialog = undefined;
      },
    };

    if (ltr === "right") {
      options.x = "right";
      options.right = 10;
    } else {
      options.x = "left";
      options.left = 10;
    }

    return options;
  }
}
new Previewr().init();
