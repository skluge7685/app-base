const { createLogger, format, transports } = require('winston');
var amqplib = require('amqplib/callback_api');
const express = require('express');
var process = require('process');
require('dotenv').config();
const fs = require('fs')

module.exports = class ServiceNode{

    //Constructor
    constructor(functionRouteCallback, serverRouteCallback) {

        this.logger = null;
        this.amqpConn = null;
        this.server = null;
        this.functionRouteCallback = functionRouteCallback;
        this.serverRouteCallback = serverRouteCallback;

        //Inital Functions
        this.checkManifest();
        this.startLogger();
        this.startAMQP();
        this.startServer();

        //Set Server Routes
        var serverRouter = express.Router();
        this.server.use('/', serverRouter);
        require(serverRouteCallback)(serverRouter, this.logger);

        // Exit Handler
        process.on('SIGINT', () => {
            this.logger.log('info', 'Service manually stop by ctrl+c', {tags: 'SERVICE'});
            console.log('######################################################################################');
            console.log('');
            process.exit();
        });
    }

    //////////////////////////////////////////////
    //Check Manifest
    checkManifest() {

        try {
            if (fs.existsSync('./manifest.json')) {
            }
            else {

                //Create JSON
                var manifest = {
                    name: require(__dirname + '/package.json').name,
                    entry_point: 'service.js',
                    environment: {},
                    routing_table: [],
                }

                //Write File
                fs.writeFileSync('./manifest.json', JSON.stringify(manifest, null, 2));
            }
          } catch(err) {
            console.log(err)
          }
    }

    //////////////////////////////////////////////
    //Start Logger
    startLogger() {

        ////////////////////////////////////////////////////
        //Logger
        this.logger = createLogger({
            level: 'info',
            format: format.combine(format.timestamp({format: 'YYYY-MM-DD HH:mm:ss'}),format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)),
            transports: [
                new transports.Console({
                    format: format.combine(format.colorize(), format.printf(function(info) {
                            
                        return `${info.timestamp} ${info.level}: [${info.tags}] ${info.message}`
                    })),
                }),
            ]
        })
    }

    //////////////////////////////////////////////
    // Connection to RabbitMQ
    startAMQP() {

        //Check Environment Variables
        if(process.env.AMQP_USER == undefined) { this.logger.log('error', 'AMQP_USER not defined.', {tags: 'AMQP'}); process.exit(1); }
        if(process.env.AMQP_PASS == undefined) { this.logger.log('error', 'AMQP_PASS not defined.', {tags: 'AMQP'}); process.exit(1); }
        if(process.env.AMQP_HOST == undefined) { this.logger.log('error', 'AMQP_HOST not defined.', {tags: 'AMQP'}); process.exit(1); }
        if(process.env.AMQP_QUERE == undefined) { this.logger.log('error', 'AMQP_QUERE not defined.', {tags: 'AMQP'}); process.exit(1); }
        if(process.env.AMQP_AUTODELETE == undefined) { this.logger.log('error', 'AMQP_AUTODELETE not defined.', {tags: 'AMQP'}); process.exit(1); }
        if(process.env.AMQP_MESSAGE_TTL == undefined) { this.logger.log('error', 'AMQP_MESSAGE_TTL not defined.', {tags: 'AMQP'}); process.exit(1); }
    
        //Checks
        if(process.env.AMQP_HOST == '') {
            this.logger.log('error', 'amqp hostname is not valid', {tags: 'AMQP'});
            process.exit(1);
        }

        const opt = { credentials: require('amqplib').credentials.plain(process.env.AMQP_USER, process.env.AMQP_PASS) };
        amqplib.connect(process.env.AMQP_HOST + "?heartbeat=60", opt, (err, conn) => {

            if (err) {
                this.logger.log('error', err.message, {tags: 'AMQP'});
                process.exit(1);
            }
    
            conn.on("error", (err) => {
                this.logger.log('warn', err.message, {tags: 'AMQP'});
            });
    
            conn.on("close", () => {
                this.logger.log('warn', 'Connection closed.', {tags: 'AMQP'});
            });

            //Success
            this.logger.log('info', 'Connected.', {tags: 'AMQP'});
            this.amqpConn = conn;
            this.startAMQPWorker();
        })

    }

    //////////////////////////////////////////////
    // AMQP Worker
    startAMQPWorker() {

        this.amqpConn.createChannel((err, ch) => {

            if (err) {
                this.logger.log('error', err.message, {tags: 'AMQP'});
                amqpConn.close();
            }
    
            ch.on("error", (err) => {
                this.logger.log('error', err.message, {tags: 'AMQP'});
            });
    
            ch.on("close", () => {
                this.logger.log('warn', 'Channel closed', {tags: 'AMQP'});
            });
    
            var amqp_args = {};
            if(parseInt(process.env.AMQP_AUTODELETE) > 0) {
                amqp_args['x-message-ttl'] = parseInt(process.env.SERVICE_MESSAGE_TTL);
            }
    
            ch.assertQueue(process.env.AMQP_QUERE, { durable: true, autoDelete: ((process.env.AMQP_MESSAGE_TTL).toLowerCase() === 'true') || false, arguments: amqp_args }, (err, _ok) => {
                
                if (err) {
                    this.logger.log('error', err.message, {tags: 'AMQP'});
                    amqpConn.close();
                }
    
                ch.consume(process.env.AMQP_QUERE, processMsg, { noAck: false });
                this.logger.log('info', `Worker is started on Queue <${process.env.AMQP_QUERE}>.`, {tags: 'AMQP'});
            });
    
            async function processMsg(msg) {
    
                //Get Work Package
                const work_package = JSON.parse(msg.content.toString());
                
                //Wait for Resolution
                var response = await require(this.functionRouteCallback)(work_package, logger);
                
                //After Finish, send Response Message
                var response_json = JSON.stringify(response);
                ch.sendToQueue(msg.properties.replyTo, new Buffer.from(response_json), {correlationId: msg.properties.correlationId});
                ch.ack(msg);
            }
        })
    }

    //////////////////////////////////////////////
    // Start Server
    startServer() {

        if(this.server != null) {
            this.logger.log('warn', 'Server is still running, abort.', {tags: 'SERVER'});
        }

        if(process.env.SERVICE_PORT == undefined) { this.logger.log('error', 'SERVICE_PORT not defined.', {tags: 'SERVER'}); process.exit(1); }

        //Start Server
        this.server = express();
        this.server.listen(process.env.SERVICE_PORT, () => {
            this.logger.log('info', `Server is running on port ${process.env.SERVICE_PORT}.`, {tags: 'SERVER'});
        }).on('error', (err) => {

            if(err.errno === 'EADDRINUSE') {
                this.logger.log('error', `Server port ${process.env.SERVICE_PORT} is busy, can not start Server`, {tags: 'SERVER'});
                process.exit(1);
            } else {
                this.logger.log('error', err, {tags: 'SERVER'});
            }
        })
    }
}