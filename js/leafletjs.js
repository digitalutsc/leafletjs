/**
 * @file
 * LeafletJS map initialization and interaction.
 */

(function (Drupal, once) {
  'use strict';

  /**
   * Escapes a value for interpolation into popup markup.
   *
   * Popup HTML is assembled by concatenation below, so plain-text values
   * coming from the uploaded data file must be escaped or any markup they
   * contain executes in the visitor's browser.
   */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Current interface language as a two-letter code.
   *
   * Reads the lang attribute on <html>, falling back to Drupal's own
   * currentLanguage. Regional tags like "en-CA" are reduced to "en".
   */
  function currentLang(settings) {
    var fromHtml = (document.documentElement.getAttribute('lang') || '').split('-')[0];
    var fromDrupal = ((settings && settings.path && settings.path.currentLanguage) || '').split('-')[0];
    return (fromHtml || fromDrupal || 'en').toLowerCase();
  }

  /**
   * Resolves a property that may be either a plain value or a map of
   * language code to value, e.g. {"en": "...", "fr": "..."}.
   *
   * Falls back to English, then to any value present, so a map missing the
   * active language still renders something rather than an empty popup.
   */
  function byLang(value, lang) {
    if (!value || typeof value === 'string') {
      return value || '';
    }
    if (value[lang]) {
      return value[lang];
    }
    if (value.en) {
      return value.en;
    }
    var keys = Object.keys(value);
    return keys.length ? value[keys[0]] : '';
  }

  Drupal.behaviors.leafletjs = {
    attach: function (context, settings) {
      once('leafletjs', '#leafletjs', context).forEach(function (element) {

        // Get default settings from Drupal
        var overrideAutofit = (settings.leafletjs && settings.leafletjs.override_autofit) ? settings.leafletjs.override_autofit : false;
        var defaultLat = (settings.leafletjs && settings.leafletjs.default_lat !== undefined) ? settings.leafletjs.default_lat : 0;
        var defaultLon = (settings.leafletjs && settings.leafletjs.default_lon !== undefined) ? settings.leafletjs.default_lon : 0;
        var defaultZoom = (settings.leafletjs && settings.leafletjs.default_zoom !== undefined) ? settings.leafletjs.default_zoom : 1;

        var tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        });

        var map = L.map('leafletjs', {
          layers: [tiles],
          minZoom: 1,
          maxZoom: 18  // Known issue: Map does not work well with non-integer zoom levels
        }).setView([defaultLat, defaultLon], defaultZoom);

        var markers = L.markerClusterGroup({
          chunkedLoading: true,
        });

        // Initialize reset control with configured default values
        var resetControl = L.control.resetView({
          position: "topleft",
          title: "Reset view",
          latlng: L.latLng([defaultLat, defaultLon]),
          zoom: defaultZoom,
        });
        resetControl.addTo(map);

        // Declared out here because the auto-fit block below is shared with the
        // CSV branch. Stays empty (and invalid) for data with no region codes.
        var focusBounds = null;

        // Check if location data is available
        if (typeof geoJsonData !== 'undefined') {
          // Hover readout. Opt-in from the data file via a top-level
          //   "info": {"placeholder": "Hover over a region"}
          // No placeholder in the data means no hover box at all, so existing
          // maps are unaffected. Treated as plain text, not markup.
          var lang = currentLang(settings);
          var infoText = byLang(geoJsonData.info && geoJsonData.info.placeholder, lang);
          var info = null;
          var hasPolygons = false;

          if (infoText) {
            info = L.control();

            info.onAdd = function () {
              this._div = L.DomUtil.create('div', 'leafletjs-info');
              this.update();
              return this._div;
            };

            info.update = function (props) {
              this._div.innerHTML = props && props.region_name
                ? '<b>' + esc(props.region_name) + '</b>'
                : esc(infoText);
            };
          }

          function highlightFeature(e) {
            e.target.setStyle({
              weight: 5,
              color: '#666',
              dashArray: '',
              fillOpacity: 0.7
            });
            e.target.bringToFront();
            if (info) {
              info.update(e.target.feature.properties);
            }
          }

          function resetHighlight(e) {
            geojson.resetStyle(e.target);
            if (info) {
              info.update();
            }
          }

          function zoomToFeature(e) {
            map.fitBounds(e.target.getBounds());
          }

          // Bounds of the Quebec regions only, so non-Quebec features (Ottawa,
          // Winnipeg) can be drawn without dragging the initial view off Quebec.
          focusBounds = L.latLngBounds([]);

          // region_code -> [layer], so a legend row can zoom to its region.
          // An array, not a single layer: a region may be drawn as several
          // separate features (Côte-Nord has a second "Tracé de 1927" polygon),
          // and zooming must frame all of them.
          var zoomTargets = {};

          // GeoJSON format
          var geojson = L.geoJSON(geoJsonData, {
            // Polygon features may carry their own fill colour. Returning an
            // empty object leaves Leaflet's defaults alone, so point/marker
            // data without a colour renders exactly as before.
            style: function (feature) {
              var colour = feature.properties && feature.properties.color;
              return colour ? {
                fillColor: colour,
                fillOpacity: 0.7,
                color: '#ffffff',
                weight: 2,
                dashArray: '3'
              } : {};
            },
            onEachFeature: function(feature, layer) {
              var p = feature.properties || {};
              var popup;

              // Any of these may be a single value or a per-language map,
              // e.g. "popupContent": {"en": "...", "fr": "..."}.
              var content = byLang(p.popupContent, lang);

              if (content) {
                // Popup markup supplied by the data file. Intentionally not
                // escaped: it is authored HTML, which is the point of it.
                popup = content;
              }
              else {
                // Fallback: thumbnail plus linked title.
                var thumbnail = byLang(p.islandora_object_thumbnail, lang);
                var url = byLang(p.search_api_url, lang);
                var title = byLang(p.title, lang);

                popup = '<div>' +
                  '<img src="' + esc(thumbnail) + '" class="popup-thumbnail" alt="' + esc(title) + '" onerror="this.style.display=\'none\'">' +
                  '<br>' +
                  '<a href="' + esc(url) + '" target="_blank" class="popup-title">' + esc(title) + '</a>' +
                  '</div>';
              }

              layer.bindPopup(popup);

              // Only vector layers can be restyled, raised, or bounds-fitted.
              // L.Marker has none of setStyle/bringToFront/getBounds, so point
              // data must not get these handlers or the first hover throws.
              if (layer.setStyle) {
                hasPolygons = true;
                if (p.region_code && layer.getBounds) {
                  (zoomTargets[p.region_code] = zoomTargets[p.region_code] || []).push(layer);
                  // Numeric codes are the Quebec administrative regions; OTT
                  // and WMR are deliberately excluded from the initial framing.
                  if (/^\d+$/.test(p.region_code)) {
                    focusBounds.extend(layer.getBounds());
                  }
                }
                layer.on({
                  mouseover: highlightFeature,
                  mouseout: resetHighlight,
                  // bindPopup already opens the popup on click; this adds the
                  // zoom, so one click does both.
                  click: zoomToFeature
                });
              }

              markers.addLayer(layer);
            }
          });

          // Needs something hoverable to be worth showing, so point-only data
          // never gets an empty panel it can never fill.
          if (info && hasPolygons) {
            info.addTo(map);
          }

          // Legend entries come from an optional top-level "legend" array in
          // the data file. Each row may zoom to a drawn region (zoomTo), link
          // out (url), or be a plain colour key with neither.
          if (geoJsonData.legend && geoJsonData.legend.length) {
            var legend = L.control({position: 'bottomright'});

            legend.onAdd = function () {
              var div = L.DomUtil.create('div', 'leafletjs-info leafletjs-legend');

              div.innerHTML = geoJsonData.legend.map(function (entry) {
                var swatch = '<i style="background:' + esc(entry.color) + '"></i> ';
                // name and url may also be per-language maps.
                var label = esc(byLang(entry.name, lang));
                // zoomTo wins over url: frame the region on this map rather
                // than navigating away. Falls back to the plain label if the
                // named region has no drawn geometry to zoom to.
                if (entry.zoomTo) {
                  return zoomTargets[entry.zoomTo]
                    ? swatch + '<a href="#" data-zoom-to="' + esc(entry.zoomTo) + '" title="' +
                      Drupal.t('Zoom to this region') + '">' + label + '</a>'
                    : swatch + label;
                }
                var entryUrl = byLang(entry.url, lang);
                return entryUrl
                  ? swatch + '<a href="' + esc(entryUrl) + '" target="_blank" rel="noopener">' + label + '</a>'
                  : swatch + label;
              }).join('<br>');

              Array.prototype.forEach.call(div.querySelectorAll('[data-zoom-to]'), function (el) {
                L.DomEvent.on(el, 'click', function (e) {
                  L.DomEvent.preventDefault(e);
                  var layers = zoomTargets[el.getAttribute('data-zoom-to')];
                  if (layers && layers.length) {
                    var bounds = layers[0].getBounds();
                    for (var i = 1; i < layers.length; i++) {
                      bounds = bounds.extend(layers[i].getBounds());
                    }
                    map.fitBounds(bounds);
                  }
                });
              });

              // Let clicks reach the links instead of panning the map, and let
              // the wheel scroll the (capped, scrollable) list instead of
              // zooming the map underneath it.
              L.DomEvent.disableClickPropagation(div);
              L.DomEvent.disableScrollPropagation(div);
              return div;
            };

            legend.addTo(map);
          }
        }
        else if (typeof addressPoints !== 'undefined' && addressPoints.length > 0) {
          // CSV array format
          for (var i = 0; i < addressPoints.length; i++) {
            var a = addressPoints[i];
            var marker = L.marker([a[0], a[1]], {title: a[2]});
            marker.bindPopup('<div><img src="' + a[3] + '" class="popup-thumbnail" alt="' + a[2] + '" onerror="this.style.display=\'none\'"><br><a href="' + a[4] + '" target="_blank" class="popup-title">' + a[2] + '</a></div>');
            markers.addLayer(marker);
          }
        }

        map.addLayer(markers);

        // Auto-fit map to markers unless override is enabled
        if (overrideAutofit) {
          // Keep configured default center and zoom
        } else {
          setTimeout(function() {
            // Prefer the Quebec-only bounds when the data supplies them; fall
            // back to every layer for point/CSV data that has no region codes.
            var bounds = (focusBounds && focusBounds.isValid())
              ? focusBounds
              : markers.getBounds();
            if (bounds.isValid()) {
              map.fitBounds(bounds, {
                padding: [50, 50],
              });

              // Update reset control to use the fitted view
              resetControl.options.latlng = map.getCenter();
              resetControl.options.zoom = map.getZoom();
            }
          }, 100);
        }
      });
    }
  };

})(Drupal, once);
