var Address = require('bitcoinjs-lib').Address
var networks = require('bitcoinjs-lib').networks
var assert = require('assert')
var Node = require('./node')

function TxGraph() {
  this.heads = []
}

TxGraph.prototype.addTx = function(tx) {
  var node = findNodeById(tx.getId(), this.heads) || new Node(tx.getId())
  if(node.nextNodes.length === 0) {
    this.heads.push(node)
  }
  node.tx = tx

  var prevNodes = tx.ins.map(function(txIn) {
    var txinId = new Buffer(txIn.hash)
    Array.prototype.reverse.call(txinId)
    txinId = txinId.toString('hex')

    return findNodeById(txinId, this.heads) || new Node(txinId)
  }, this)

  prevNodes.forEach(function(n) {
    var i = this.heads.indexOf(n)
    if(i >= 0) this.heads.splice(i, 1)

    n.addToNextNodes(node)
  }, this)
}

TxGraph.prototype.getAllNodes = function() {
  var found = {}
  bft(this.heads, found)
  return values(found)
}

TxGraph.prototype.findNodeById = function(id) {
  return findNodeById(id, this.heads)
}

TxGraph.prototype.getTails = function() {
  var results = {}
  this.heads.forEach(function(head) {
    dfs(head, results)
  })
  return values(results)
}

TxGraph.prototype.calculateFees = function() {
  this.calculateFeesAndValues()
}

TxGraph.prototype.calculateFeesAndValues = function(addresses, network) {
  addresses = addresses || []
  if(!Array.isArray(addresses)) addresses = [addresses]

  network = network || networks.bitcoin

  var tails = this.getTails()
  assertEmptyNodes(tails)

  var tailsNext = tails.reduce(function(memo, node) {
    return memo.concat(node.nextNodes)
  }, [])
  assertNoneFundingNodes(tailsNext, addresses, network)

  this.heads.forEach(function(node) {
    calculateFeesAndValuesForPath(node, addresses, network)
  })
}

function findNodeById(txid, nodes) {
  if(!nodes || nodes.length === 0) return

  var result
  nodes.some(function(node) {
    var found = node.id === txid
    if(found) { result = node }
    return found
  })

  if(result) return result

  var children = []
  nodes.forEach(function(n) {
    children = children.concat(n.prevNodes)
  })

  return findNodeById(txid, children)
}

function bft(nodes, found) {
  if(!nodes || nodes.length === 0) return []

  var children = []
  nodes.forEach(function(n) {
    if(found[n.id]) return

    found[n.id] = n
    children = children.concat(n.prevNodes).concat(n.nextNodes)
  })

  return bft(children, found)
}

function dfs(start, results) {
  if(start.prevNodes.length > 0) {
    start.prevNodes.forEach(function(node) {
      dfs(node, results)
    })
  } else {
    results[start.id] = start
  }
}

function values(obj) {
  var results = []
  for(var k in obj) {
    results.push(obj[k])
  }
  return results
}

function assertEmptyNodes(nodes) {
  assert(nodes.every(function(node) {
    return node.tx == null
  }), "expect graph tails to contain only tx ids")
}

function assertNoneFundingNodes(nodes, addresses, network) {
  assert(nodes.every(function(node) {
      var outputAddresses = node.tx.outs.map(function(output) {
        return Address.fromOutputScript(output.script, network).toString()
      })
      var partOfOutput = outputAddresses.some(function(address) {
        addresses.indexOf(address) >= 0
      })

      return !partOfOutput
  }), "expect graph to contain the input transactions of the first funding transactions")

}

function calculateFeesAndValuesForPath(node, addresses, network) {
  if(node.prevNodes.length === 0) return;

  var feeAndValue = calculateFeeAndValue(node, addresses, network)
  node.tx.fee = feeAndValue.fee
  node.tx.value = feeAndValue.value

  node.prevNodes.forEach(function(n) {
    calculateFeesAndValuesForPath(n, addresses, network)
  })
}

function calculateFeeAndValue(node, addresses, network) {
  var tx = node.tx

  var inputFeeAndValue = tx.ins.reduce(function(memo, input) {
    var buffer = new Buffer(input.hash)
    Array.prototype.reverse.call(buffer)
    var inputTxId = buffer.toString('hex')

    var prevNode = node.prevNodes.filter(function(node) {
      return node.id === inputTxId
    })[0]

    assert(prevNode != undefined, 'missing node in graph: ' + inputTxId)

    if(!prevNode.tx) return NaN;

    var output = prevNode.tx.outs[input.index]
    memo.fee = memo.fee + output.value

    var toAddress = Address.fromOutputScript(output.script, network).toString()
    if(addresses.indexOf(toAddress) >= 0) {
      memo.value = memo.value + output.value
    }

    return memo
  }, {fee: 0, value: 0})

  if(isNaN(inputFeeAndValue.fee)) return {};

  var outputFeeAndValue = tx.outs.reduce(function(memo, output) {
    memo.fee = memo.fee + output.value

    var toAddress = Address.fromOutputScript(output.script, network).toString()
    if(addresses.indexOf(toAddress) >= 0) {
      memo.value = memo.value + output.value
    }

    return memo
  }, {fee: 0, value: 0})

  return {
    fee: inputFeeAndValue.fee - outputFeeAndValue.fee,
    value: outputFeeAndValue.value - inputFeeAndValue.value
  }
}

module.exports = TxGraph
