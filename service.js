const { createLogger, format, transports } = require('winston');
var amqplib = require('amqplib/callback_api');
require('dotenv').config();
var logger = null;

var ServiceClass = require('./service_class');
var service = new ServiceClass(null, './serverRoutes.js');

//////////////////////////////////////////////
// Initilize Service
//initService();
function initService() {

    startLogger();
    startAMQP(logger);
}

//////////////////////////////////////////////
//Start Logger
function startLogger() {

    ////////////////////////////////////////////////////
    //Logger
    logger = createLogger({
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
var amqpConn = null;
function startAMQP(logger) {

    //Check Environment Variables
    if(process.env.AMQP_USER == undefined) { logger.log('error', 'AMQP_USER not defined.', {tags: 'AMQP'}); process.exit(1); }
    if(process.env.AMQP_PASS == undefined) { logger.log('error', 'AMQP_PASS not defined.', {tags: 'AMQP'}); process.exit(1); }
    if(process.env.AMQP_HOST == undefined) { logger.log('error', 'AMQP_HOST not defined.', {tags: 'AMQP'}); process.exit(1); }
    if(process.env.AMQP_QUERE == undefined) { logger.log('error', 'AMQP_QUERE not defined.', {tags: 'AMQP'}); process.exit(1); }
    if(process.env.AMQP_AUTODELETE == undefined) { logger.log('error', 'AMQP_AUTODELETE not defined.', {tags: 'AMQP'}); process.exit(1); }
    if(process.env.AMQP_MESSAGE_TTL == undefined) { logger.log('error', 'AMQP_MESSAGE_TTL not defined.', {tags: 'AMQP'}); process.exit(1); }

    const opt = { credentials: require('amqplib').credentials.plain(process.env.AMQP_USER, process.env.AMQP_PASS) };
    amqplib.connect(process.env.AMQP_HOST + "?heartbeat=60", opt, function(err, conn) {

        if (err) {
            logger.log('error', err.message, {tags: 'AMQP'});
            process.exit(1);
        }

        conn.on("error", function(err) {
            if (err.message !== "Connection closing") {
                logger.log('warn', err.message, {tags: 'AMQP'});
            }
        });

        conn.on("close", function() {

            logger.log('warn', 'Connection closed.', {tags: 'AMQP'});
        });

        //Success
        logger.log('info', 'Connected.', {tags: 'AMQP'});
        amqpConn = conn;

        AMQPWorker(process.env.AMQP_QUERE);
    })
}

//////////////////////////////////////////////
// Message Queue Worker
function AMQPWorker(queue) {

    amqpConn.createChannel(function(err, ch) {

        if (closeOnErr(err)) return;

        ch.on("error", function(err) {
            logger.log('error', err.message, {tags: 'AMQP'});
        });

        ch.on("close", function() {
            logger.log('warn', 'Channel closed', {tags: 'AMQP'});
        });

        var arguments = {};
        if(parseInt(process.env.AMQP_MESSAGE_TTL) > 0) {
            arguments['x-message-ttl'] = parseInt(process.env.AMQP_MESSAGE_TTL);
        }

        ch.assertQueue(queue, { durable: true, autoDelete: ((process.env.AMQP_AUTODELETE).toLowerCase() === 'true') || false, arguments: arguments }, function(err, _ok) {
            if (closeOnErr(err)) return;

            ch.consume(queue, processMsg, { noAck: false });
            logger.log('info', `Worker is started on Queue <${queue}>.`, {tags: 'AMQP', additionalInfo: {}});
        });

        async function processMsg(msg) {

            //Get Work Package
            const work_package = JSON.parse(msg.content.toString());
            
            //Wait for Resolution
            var response = await require('./service_src/router.js')(work_package, service_data, logger);
            
            //After Finish, send Response Message
            var response_json = JSON.stringify(response);
            ch.sendToQueue(msg.properties.replyTo, new Buffer.from(response_json), {correlationId: msg.properties.correlationId});
            ch.ack(msg);
        }
    })
}

//////////////////////////////////////////////
// AMQP Help Function
function closeOnErr(err) {

    if (!err) return false;

    console.log('[AMQP] Error -> ' + err.message);
    amqpConn.close();
    return true;
}