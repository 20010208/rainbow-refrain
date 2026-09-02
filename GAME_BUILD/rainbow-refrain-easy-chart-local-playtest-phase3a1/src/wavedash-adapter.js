(function(root) {
  'use strict';
  root.RainbowRefrainWavedash = {
    init: function() {
      var host = root.Wavedash;
      if (host && typeof host.init === 'function') host.init();
      return !!(host && typeof host.init === 'function');
    }
  };
})(globalThis);
