module.exports = function(work_package, logger) {

    return new Promise((resolve, reject) => {

        const response = {code: 200, status: 'OK', message: 'Das ist ein Test.', data: {}, service: {message: 'Fehler'}, success: true};
        console.log(work_package);

        resolve(response);
    })
}