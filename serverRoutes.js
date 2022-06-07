module.exports = function(router, logger) {

    router.get('/test', (req, res) => {
        
        return res.status(200).json({data: 'OK'});
    })
}