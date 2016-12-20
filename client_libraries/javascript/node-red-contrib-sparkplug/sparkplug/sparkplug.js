/**
 * Copyright (c) 2016 Cirrus Link Solutions
 *
 *  All rights reserved. This program and the accompanying materials
 *  are made available under the terms of the Eclipse Public License v1.0
 *  which accompanies this distribution, and is available at
 *  http://www.eclipse.org/legal/epl-v10.html
 *
 * Contributors:
 *   Cirrus Link Solutions
 */

module.exports = function(RED) {
    var SparkplugClient = require('sparkplug-client');
    var deviceCache = {} // A cache of data for devices

    function SparkplugNode(config) {
        RED.nodes.createNode(this, config);
        var node = this,
            username = this.credentials.user,
            password = this.credentials.password,
            version = config.version,
            cacheEnabled = config.enablecache == "true",
            sparkPlugConfig = {
                'serverUrl' : config.broker + ":" + config.port,
                'username' : username,
                'password' : password,
                'groupId' : config.groupid,
                'edgeNode' : config.edgenode,
                'clientId' : config.clientid,
                'publishDeath' : config.publishdeath == "true",
                'version' : version
            },
            sparkplugClient;

        try {
            // Create the SparkplugClient
            sparkplugClient = SparkplugClient.newClient(sparkPlugConfig);
        } catch (e) {
            node.error("Error creating new client", e);
        }

        /*
         * 'rebirth' handler
         */
        sparkplugClient.on('rebirth', function () {
            node.log(config.edgenode + " received 'rebirth' event");
            // If device cache is enabled, send birth on behalf of device
            if (cacheEnabled) {
                // Loop over all devices in the device data cache
                Object.keys(deviceCache).forEach(function(key) {
                    var payload = { 
                        "timestamp" : new Date().getTime()
                    };
                    if (version === "spBv1.0") {
                        // Sparkplug B uses "metrics" as the key
                        payload.metrics = deviceCache[key];
                    } else {
                        // Sparkplug A uses "metric" as the key
                        payload.metric = deviceCache[key];
                    }
                    // Publish BIRTH certificate for device
                    sparkplugClient.publishDeviceBirth(key, payload);
                });
            } else {
                node.log(config.edgenode + " sending 'rebirth' message to downstream nodes");
                node.send({
                    "topic" : "rebirth",
                    "payload" : {}
                });
            }
        });

        /*
         * 'command' handler
         */
        sparkplugClient.on('command', function (deviceId, payload) {
            node.log(config.edgenode + " received 'command' event for deviceId: " + deviceId + ", sending to nodes");
            node.send({
                "topic" : deviceId,
                "payload" : payload
            });

        });

        /*
         * 'error' handler
         */
        sparkplugClient.on('error', function (error) {
            node.log(config.edgenode + " received 'error' event: " + error);
            node.status( {
                fill:"red", 
                shape:"ring", 
                text:"disconnected"
            });
        });

        /*
         * 'connect' handler
         */
        sparkplugClient.on('connect', function () {
            node.log(config.edgenode + " received 'connect' event");
            node.status( {
                fill:"green", 
                shape:"dot", 
                text:"connected"
            });
        });

        /*
         * 'connect' handler
         */
        sparkplugClient.on('reconnect', function () {
            node.log(config.edgenode + " received 'reconnect' event");
            node.status( {
                fill:"yellow", 
                shape:"ring", 
                text:"connecting"
            });
        });

        /*
         * Receive 'input' message.  
         * The topic should be of the format: <deviceId>/<messageType>
         * where <messageType> can be one of: DDATA, DBIRTH, or DDEATH.
         */
        this.on('input', function(msg) {
            var tokens = msg.topic.split("/"),
                payload = msg.payload,
                publishBirth = false,
                deviceId, messageType, cachedMetrics;

            node.log(config.edgenode + " recieved input msg: " + JSON.stringify(msg));

            if (tokens.length != 2) {
                node.error(config.edgenode + " received message with invalid topic " + msg.topic + ", must be of the form <deviceId>/<msgType>");
                return;
            }

            // Parse topic to get deviceId and messageType
            deviceId = tokens[0];
            messageType = tokens[1];

            // Get cached device
            cachedMetrics = deviceCache[deviceId];

            if (messageType === "DBIRTH") {
                if (cacheEnabled) {
                    console.log("Setting device cache for " + deviceId);
                    deviceCache[deviceId] = version === "spBv1.0" 
                            ? payload.metrics 
                            : payload.metric;
                }
                // Publish device birth
                sparkplugClient.publishDeviceBirth(deviceId, payload);
            } else if (messageType === "DDATA") {
                if (cacheEnabled) {
                    if (cachedMetrics === undefined) {
                        node.error(config.edgenode + " received a DDATA for unknown device " + deviceId);
                        return;
                    }

                    var metrics = version === "spBv1.0" 
                            ? payload.metrics 
                            : payload.metric;

                    // Update metrics in device cache
                    // Loop over incoming metrics
                    metrics.forEach(function(metric) {
                        // Loop through cached metrics to check if the incoming metric is cached
                        // then update the value in the cache.
                        if(!cachedMetrics.some(function(cachedMetric) {
                                if (cachedMetric.name === metric.name) {
                                    // Update metric value
                                    cachedMetric.value = metric.value;
                                    return true;
                                }
                                return false;
                            })) {
                            node.warn(config.edgenode + " received a DDATA message with an unknown metric");
                            // Add new metric
                            cachedMetrics.push(metric);
                        }
                    });
                }
                // Publish device data
                sparkplugClient.publishDeviceData(deviceId, payload);
            } else if (messageType === "DDEATH") {
                // Clear device cache
                delete deviceCache[deviceId];
                // Publish device data
                sparkplugClient.publishDeviceDeath(deviceId, payload);
            }
        });

        /*
         * Received 'close' message.
         */
        this.on('close', function() {
            // Stop the sparkplug client
            sparkplugClient.stop();
        });
    };

    // Register the sparkplug node
    RED.nodes.registerType("sparkplug", SparkplugNode, {
        credentials: {
            user: {type:"text"},
            password: {type:"password"}
        }
    });
}
