/* Copyright 2015 Google Inc. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/
var assert = chai.assert;

module TF.Backend {
  interface MockRequest {
    resolve: Function;
    reject: Function;
    id: number;
    url: string;
  }

  class MockedRequestManager extends TF.Backend.RequestManager {
    private resolvers: Function[];
    public requestsDispatched: number;

    constructor(maxRequests = 10) {
      super(maxRequests);
      this.resolvers = [];
      this.requestsDispatched = 0;
    }

    protected _promiseFromUrl(url) {
      return new Promise((resolve, reject) => {
        var mockJSON = {
          ok: true,
          json: function() { return url; },
          url: url,
          status: 200,
        };
        this.resolvers.push(function() { resolve(mockJSON); });
        this.requestsDispatched++;
      });
    }

    public resolveFakeRequest() {
      this.resolvers.pop()();
    }

    public dispatchAndResolve() {
      // Wait for at least one request to be dispatched, then resolve it.
      this.waitForDispatch(1).then(() => this.resolveFakeRequest());
    }

    public waitForDispatch(num) {
      return waitForCondition(() => {return this.requestsDispatched >= num; });
    }
  }

  /* Create a promise that returns when *check* returns true. */
  // May cause a test timeout if check never becomes true.
  function waitForCondition(check: () => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      var go = function() {
        if (check()) {
          resolve();
        }
        setTimeout(go, 2);
      };
      go();
    });
  }

  describe("backend", () => {
    describe("request manager", () => {
      it("request loads JSON properly", (done) => {
        var rm = new TF.Backend.RequestManager();
        var promise = rm.request("example.json");
        promise.then(
          (response) => {
            assert.deepEqual(response, {foo: 3, bar: "zoidberg"});
            done();
          },
          (reject) => {
            throw new Error(reject);
          });
      });

      it("rejects on bad url", (done) => {
        var rm = new TF.Backend.RequestManager();
        var bad_url = "_bad_url_which_doesnt_exist.json";
        var promise = rm.request(bad_url);
        promise.then(
          (response) => {
            throw new Error("the promise should have rejected");
          },
          (reject) => {
            assert.instanceOf(reject, Error);
            assert.include(reject.message, "404");
            assert.include(reject.message, bad_url);
            done();
        });
      });

      it("requestManager only sends maxRequests requests at a time", (done) => {
        var rm = new MockedRequestManager(3);
        var requestsConcluded = 0;
        var r0 = rm.request("1");
        var r1 = rm.request("2");
        var r2 = rm.request("3");
        var r3 = rm.request("4");
        assert.equal(rm.activeRequests(), 3, "three requests are active");
        assert.equal(rm.outstandingRequests(), 4, "four requests are pending");
        rm.waitForDispatch(3).then(() => {
          assert.equal(rm.activeRequests(), 3, "three requests are still active (1)");
          assert.equal(rm.requestsDispatched, 3, "three requests were dispatched");
          rm.resolveFakeRequest();
          return rm.waitForDispatch(4);
        }).then(() => {
          assert.equal(rm.activeRequests(), 3, "three requests are still active (2)");
          assert.equal(rm.requestsDispatched, 4, "four requests were dispatched");
          assert.equal(rm.outstandingRequests(), 3, "three requests are pending");
          rm.resolveFakeRequest();
          rm.resolveFakeRequest();
          rm.resolveFakeRequest();
          return r3;
        }).then(() => {
          assert.equal(rm.activeRequests(), 0, "all requests finished");
          assert.equal(rm.outstandingRequests(), 0, "no requests pending");
          done();
        });
      });

      it("queue is LIFO", (done) => {
      /* This test is a bit tricky.
      * We want to verify that the RequestManager queue has LIFO semantics.
      * So we construct three requests off the bat: A, B, C.
      * So LIFO semantis ensure these will resolve in order A, C, B.
      * (Beacuse the A request launches immediately when we create it, it's not in queue)
      * Then after resolving A, C moves out of queue, and we create X.
      * So expected final order is A, C, X, B.
      * We verify this with an external var that counts how many requests were resolved.
      */
        var rm = new MockedRequestManager(1);
        var nResolved = 0;
        function assertResolutionOrder(expectedSpotInSequence) {
          return function() {
            nResolved++;
            assert.equal(expectedSpotInSequence, nResolved);
          };
        }

        function launchThirdRequest() {
          rm.request("started late but goes third")
          .then(assertResolutionOrder(3))
          .then(() => rm.dispatchAndResolve());
        }

        rm.request("first")
          .then(assertResolutionOrder(1)) // Assert that this one resolved first
          .then(launchThirdRequest)
          .then(() => rm.dispatchAndResolve()); // then trigger the next one

        rm.request("this one goes fourth") // created second, will go last
          .then(assertResolutionOrder(4)) // assert it was the fourth to get resolved
          .then(done); // finish the test

        rm.request("second")
          .then(assertResolutionOrder(2))
          .then(() => rm.dispatchAndResolve());

        rm.dispatchAndResolve();
      });

      it("requestManager can clear queue", (done) => {
        var rm = new MockedRequestManager(1);
        var requestsResolved = 0;
        var requestsRejected = 0;
        var success = () => requestsResolved++;
        var failure = (err) => {
          assert.equal(err.name, "RequestCancellationError");
          requestsRejected++;
        };
        var finishTheTest = () => {
          assert.equal(rm.activeRequests(), 0, "no requests still active");
          assert.equal(rm.requestsDispatched, 1, "only one req was ever dispatched");
          assert.equal(rm.outstandingRequests(), 0, "no pending requests");
          assert.equal(requestsResolved, 1, "one request got resolved");
          assert.equal(requestsRejected, 4, "four were cancelled and threw errors");
          done();
        };
        rm.request("0").then(success, failure).then(finishTheTest);
        rm.request("1").then(success, failure);
        rm.request("2").then(success, failure);
        rm.request("3").then(success, failure);
        rm.request("4").then(success, failure);
        assert.equal(rm.activeRequests(), 1, "one req is active");
        rm.waitForDispatch(1).then(() => {
          assert.equal(rm.activeRequests(), 1, "one req is active");
          assert.equal(rm.requestsDispatched, 1, "one req was dispatched");
          assert.equal(rm.outstandingRequests(), 5, "five reqs outstanding");
          rm.clearQueue();
          rm.resolveFakeRequest();
          // resolving the first request triggers finishTheTest
        });
      });
    });
  });
}
