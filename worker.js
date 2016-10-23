/**
 * Cashier-BTC
 * -----------
 * Self-hosted bitcoin payment gateway
 *
 * License: WTFPL
 * Author: Igor Korsakov
 * */

/*
	этот воркер обходит все адреса, помечает оплаченые
	и выстреливает коллбеки
*/
var request = require('request'),
  async = require('async'),
  storage = require('./models/storage'),
  blockchain = require('./models/blockchain'),
  config = require('./config')

var mode = 'unprocessed'  // can be also 'unpaid'
/*
	there are two modes. in one mode (unprocessed) we search for all documents  where  doc.processed=='unprocessed'  or  doc.processed is not set.
	in case if address is not paid, we set doc.processed to 'unpaid'.
	once we run out of 'unprocessed' documents, we do the same for all 'unpaid' documents, marking them 'unprocessed'.
	thus, it makes an infinite loop for all matching documents
*/

var iteration = function (next) { // тело воркера
  async.waterfall([
    get_job,
    prepare_job,
    process_job,
    save_job_results
  ], function () {
    if (++iteration.num_times_executed >= 10000) {
      process.exit(0)
    } else {
      next()
    }
  })
}

iteration.num_times_executed = 0

async.forever(
	iteration
)

function get_job (callback) {
  if (mode == 'unprocessed') {
    storage.get_unprocessed_adresses_younger_than(Math.floor(Date.now() / 1000) - config.process_unpaid_for_period, function (json) { return callback(null, json) })
  }
  if (mode == 'unpaid') {
    storage.get_unpaid_adresses_younger_than(Math.floor(Date.now() / 1000) - config.process_unpaid_for_period, function (json) { return callback(null, json) })
  }
}

function prepare_job (json, callback) {
  json = JSON.parse(json)
  if (!json || typeof json.rows == 'undefined' || typeof json.rows[0] == 'undefined') { // no jobs, inverting mode
    console.log('no jobs, inverting mode')
    if (mode == 'unprocessed') {
      mode = 'unpaid'
    } else {
      mode = 'unprocessed'
    }
    return callback(null, false)  // пробрасываем чтоб waterfall доходил до логического конца
  }
  if (typeof json.rows[0] == 'undefined') {
    return callback(null, false)
  }  // пробрасываем чтоб waterfall доходил до логического конца

  json = json.rows[0].doc

	// атомарная операция - меняем статус на 'processing'
	// если другой воркер пытается сделать то же самое в это же время -
	// получится только у одного, остальные воркеры задачу пропустят
  storage.take_job(json, function (error, response) {
    if (!error && (response.statusCode == 201 || response.statusCode == 202)) {
      json._rev = response.body.rev
            // получилось, задача наша, поехали дальше
      return callback(null, json)
    } else {
            // не получилось, пропустим задачу и всю итерацию
	    console.log('take_job error: ', error, response)
      return callback(null, false)
    }
  })
}

function process_job (job, callback) {
  if (job === false) {
    return callback(null, false)
  }  // пробрасываем чтоб waterfall доходил до логического конца

  blockchain.get_address(job.address, function (resp) {
    {
			// check for actually paid bitcoins here
			// and fire url callback
      console.log('address: ' + job.address + ' expect: ' + job.btc_to_ask + ' confirmed: ' + (resp.btc_actual) + ' unconfirmed: ' + (resp.btc_unconfirmed))

      var paid = false
      if (job.btc_to_ask >= config.small_amount_threshhold) { // thats a lot, so we better check confirmed balance
        if ((resp.btc_actual) / job.btc_to_ask >= 0.95) {
          paid = true
        }
      } else { // not a huge amount, so we can check unconfirmed balace
        if ((resp.btc_unconfirmed) / job.btc_to_ask >= 0.95) {
          paid = true
        }
      }

      if (paid) {
        job.processed = 'paid'
        console.log('firing callback: ' + job.callback_url)
        request({ uri: job.callback_url, timeout: 10 * 1000 }, function (error) {
          if (error) {
            console.log(error)
          }
          return callback(null, job)
        })
      } else if (!paid) {
        if (mode == 'unprocessed') {
          job.processed = 'unpaid'
        }
        if (mode == 'unpaid') {
          job.processed = 'unprocessed'
        }
        return callback(null, job)
      }
    }
  })
}

function save_job_results (json, callback) {
  if (json === false) {
    return callback(null, false)
  } // пробрасываем чтоб waterfall доходил до логического конца
  storage.save_job_results(json, 		function (error, response) {
    if (!error && (response.statusCode == 201 || response.statusCode == 202)) {
      return callback(null)
    } else {
      console.log('save_job_results error:' + JSON.stringify(response) + ' ' + JSON.stringify(error))
      return callback(null, false)
    }
  })
}
