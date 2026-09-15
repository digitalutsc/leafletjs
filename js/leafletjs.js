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

        // Check if location data is available
        if (typeof geoJsonData !== 'undefined') {
          // Hover readout. Only added when the data has polygons to hover.
          var info = L.control();

          info.onAdd = function () {
            this._div = L.DomUtil.create('div', 'leafletjs-info');
            this.update();
            return this._div;
          };

          info.update = function (props) {
            var body = props && props.region_name
              ? '<b>' + esc(props.region_name) + '</b>'
              : Drupal.t('Hover over a region');
            this._div.innerHTML = body;
          };

          function highlightFeature(e) {
            e.target.setStyle({
              weight: 5,
              color: '#666',
              dashArray: '',
              fillOpacity: 0.7
            });
            e.target.bringToFront();
            info.update(e.target.feature.properties);
          }

          function resetHighlight(e) {
            geojson.resetStyle(e.target);
            info.update();
          }

          function zoomToFeature(e) {
            map.fitBounds(e.target.getBounds());
          }

          var hasPolygons = false;
          // region_code -> layer, so a legend row can zoom to its region.
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

              if (p.popupContent) {
                // Popup markup supplied by the data file. Intentionally not
                // escaped: it is authored HTML, which is the point of it.
                popup = p.popupContent;
              }
              else {
                // Fallback: thumbnail plus linked title.
                var thumbnail = p.islandora_object_thumbnail || '';
                var url = p.search_api_url || '';
                var title = p.title || '';

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
                  zoomTargets[p.region_code] = layer;
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

          if (hasPolygons) {
            info.addTo(map);
          }

          // Legend entries come from an optional top-level "legend" array in
          // the data file, for regions that have no geometry to draw.
          if (geoJsonData.legend && geoJsonData.legend.length) {
            var legend = L.control({position: 'bottomright'});

            legend.onAdd = function () {
              var div = L.DomUtil.create('div', 'leafletjs-info leafletjs-legend');

              div.innerHTML = geoJsonData.legend.map(function (entry) {
                var swatch = '<i style="background:' + esc(entry.color) + '"></i> ';
                var label = esc(entry.name);
                // zoomTo wins over url: frame the region on this map rather
                // than navigating away. Falls back to the plain label if the
                // named region has no drawn geometry to zoom to.
                if (entry.zoomTo) {
                  return zoomTargets[entry.zoomTo]
                    ? swatch + '<a href="#" data-zoom-to="' + esc(entry.zoomTo) + '">' + label + '</a>'
                    : swatch + label;
                }
                return entry.url
                  ? swatch + '<a href="' + esc(entry.url) + '" target="_blank" rel="noopener">' + label + '</a>'
                  : swatch + label;
              }).join('<br>');

              Array.prototype.forEach.call(div.querySelectorAll('[data-zoom-to]'), function (el) {
                L.DomEvent.on(el, 'click', function (e) {
                  L.DomEvent.preventDefault(e);
                  var target = zoomTargets[el.getAttribute('data-zoom-to')];
                  if (target) {
                    map.fitBounds(target.getBounds());
                  }
                });
              });

              // Let clicks reach the links instead of panning the map.
              L.DomEvent.disableClickPropagation(div);
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
            var bounds = markers.getBounds();
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
