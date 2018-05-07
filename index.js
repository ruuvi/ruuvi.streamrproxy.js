"use strict";
const express = require('express');
const http = require('http');
const os = require('os');

const bodyParser = require('body-parser');
const jsonParser = bodyParser.json();
const ruuviParser = require('ruuvi.endpoints.js');
//GW sends malformed JSON, work around it
const gwjsonParser = bodyParser.text({ type: 'application/json' });
const dJSON = require('dirty-json');

// dJSON is async, patch express support
const aa = require('express-async-await');
const app = aa(express());

const config = require('./streamr-configuration.js')

const data_port = config.data_port;
const STREAM_ID = config.STREAM_ID;
const API_KEY   = config.API_KEY;

// Create the streamr client and give the API key to use by default
const StreamrClient = require('streamr-client')
const streamr_client = new StreamrClient({
  apiKey: API_KEY
});

// https://gist.github.com/tauzen/3d18825ae41ff3fc8981
const byteToHexString = function (uint8arr) {
  if (!uint8arr) {
    return '';
  }
  
  var hexStr = '';
  for (var i = 0; i < uint8arr.length; i++) {
    var hex = (uint8arr[i] & 0xff).toString(16);
    hex = (hex.length === 1) ? '0' + hex : hex;
    hexStr += hex;
  }
  
  return hexStr.toUpperCase();
}

const hexStringToByte = function(str) {
  if (!str) {
    return new Uint8Array();
  }
  
  var a = [];
  for (var i = 0, len = str.length; i < len; i+=2) {
    a.push(parseInt(str.substr(i,2),16));
  }
  
  return new Uint8Array(a);
}

app.use((req, res, next) => {
  const start = Date.now()

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`Request to ${req.path} took ${duration}ms`);
  })
  return next();
})

// { deviceId: 'laurin-s8',
//   eventId: '591db9bc-32f0-4059-86e0-8e6cc808492c',
//   tags: 
//    [ { accelX: 0.019,
//        accelY: -0.003,
//        accelZ: 1.041,
//        defaultBackground: 0,
//        favorite: false,
//        humidity: 88,
//        id: 'F8:AC:76:59:5B:24',
//        name: 'Over Humidity',
//        pressure: 974.01,
//        rawDataBlob: [Object],
//        rssi: -45,
//        temperature: 27.25,
//        updateAt: 'Mar 6, 2018 11:21:46',
//        voltage: 2.989 } ],
//   time: 'Mar 6, 2018 11:21:46' }

/**
 * Handle data from RuuviStation app. 
 */
 app.post('/ruuvistation', jsonParser, function (req, res) {
  let measurements = req.body;

    // IF ruuvi station data
    if(measurements.tags && Array.isArray(measurements.tags)){
     measurements.tags.forEach(function(sample){
      console.log(byteToHexString(sample.rawDataBlob.blob));
      let binary = sample.rawDataBlob.blob.slice(7);
      // Skip non-broadcast types
      if(binary[0] < 2 || binary[0] > 5) { return; }
      let data = ruuviParser.parse(binary);
      data.rssi = sample.rssi;
      data.timestamp = sample.time;
      data.mac = sample.id;
      data.gateway = measurements.deviceId;
      console.log(data);
      
      // Produce the event to the Stream
      streamr_client.produceToStream(config.STREAM_ID, data)
        .then(() => function(){})
        .catch((err) => console.error(err))
        });
   }else {console.log("not an array"); }
   res.send("ok");;
 });

app.post('/gateway', gwjsonParser, async function (req, res) {
  let str = req.body;
  if(!str) 
  { 
    res.send("invalid");
    return;
  }
  let measurements = await dJSON.parse(str);

    // IF GW data
    if(Array.isArray(measurements)){
      let influx_samples = [];
      measurements.forEach(function(sample){
        // print debug data to console TODO log file
        if(sample.name === "gateway"){
          console.log(sample.action);
          //For each is a function call, "continue"
          return;
        }

        // Handle data points from RuuviTag broadcast formats
        if(sample.type &&
         sample.type === "Unknown" &&
         sample.rawData &&
         sample.rawData.includes("FF99040"))
        {
          console.log(sample);
          let binary = hexStringToByte(sample.rawData.indexOf("FF99040") + 6);
          let data = ruuviParser.parse(binary);
        }
      });
    }else console.log("not an array");

    res.send("ok");
  });


app.post('/scanner', jsonParser, async function (req, res) {
  let str = req.body;
  if(!str) 
  { 
    res.send("invalid");
    return;
  }
  let measurements = req.body;

  // IF GW data
  if(Array.isArray(measurements)){
    let streamr_samples = [];
    measurements.forEach(function(sample){

       //Handle data points from broadcast formats
       if(sample.type &&
         sample.type === "Ruuvi"
         && sample.dataPayload
         && sample.dataPayload.startsWith("9904")) {

         let data = ruuviParser.parse(Buffer.from(sample.dataPayload.substring(4), 'hex'));
       data.timestamp = sample.timestamp;
       data.rssi = sample.rssi;
       console.log(data);
         // Produce the event to the Stream
         streamr_client.produceToStream(config.STREAM_ID, data)
         .then(() => function(){})
         .catch((err) => console.error(err))
       }
     });
  } else { console.log("Incoming data is not an array"); }
  res.send("ok");
});

http.createServer(app).listen(data_port, function () {
  console.log('Listening on port ' + data_port);
});

process
.on('unhandledRejection', (reason, p) => {
  console.error(reason, 'Unhandled Rejection at Promise', p);
})
.on('uncaughtException', err => {
  console.error(err, 'Uncaught Exception thrown');
    // process.exit(1);
  });