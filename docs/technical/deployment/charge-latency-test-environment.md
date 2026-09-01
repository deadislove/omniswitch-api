# Reproducing a Real Charge Round-Trip in a Test Cluster

`scripts/mock-psp/server.js` is a real HTTP server implementing
Stripe-shaped (`/v1/...`) and Adyen-shaped (`/adyen/...`) routes, plus
`/fx/rates`, `/kyc/verify`, and `/bank/transfers` — everything
`PaymentLifecycleService`'s adapters call. `docker-compose.yml` runs it
directly (`node:20-alpine` + a bind-mounted `server.js`, port 4000). No
equivalent exists in `k8s/`, and that's intentional: `k8s/configmap.yaml`
points `ADYEN_BASE_URL` at the real `checkout-live.adyen.com` and leaves
`STRIPE_BASE_URL` unset (defaulting to the real Stripe API) — that's the
correct production shape, and a mock PSP has no place as a permanent,
tracked part of it.

This document is the recipe for standing up `mock-psp` temporarily in a
test cluster anyway, when what's actually needed is a full charge
round-trip (not just `NetworkPolicy` correctness, which doesn't need a
real backend at all) — e.g. measuring end-to-end charge latency, or
exercising `PaymentLifecycleService`'s full adapter path against
something that actually responds instead of a fake TCP listener.

## Prerequisites

The real `k8s/` manifests already deployed and healthy — `postgres.yaml`,
`redis.yaml`, `vault.yaml`, `pgbouncer.yaml`, `network-policy.yaml`,
`configmap.yaml`, `secret.yaml`, `deployment.yaml`, `service.yaml` (see
[`prerequisites.md`](./prerequisites.md) for the install order).
Everything below layers on top of that, and none of it modifies those
tracked files.

## 1. Deploy `mock-psp`

Generate the ConfigMap directly from the real, tracked script — this
keeps the deployed copy in sync with `scripts/mock-psp/server.js`
automatically, rather than duplicating its content into a second file
that can drift:

```
kubectl create configmap mock-psp-script -n payments \
  --from-file=server.js=scripts/mock-psp/server.js
```

Then the Deployment and Service:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mock-psp
  namespace: payments
  labels:
    app: mock-psp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mock-psp
  template:
    metadata:
      labels:
        app: mock-psp
    spec:
      containers:
        - name: mock-psp
          image: node:20-alpine
          command: ["node", "/app/server.js"]
          ports:
            - containerPort: 4000
          volumeMounts:
            - name: script
              mountPath: /app
          readinessProbe:
            tcpSocket:
              port: 4000
            initialDelaySeconds: 2
            periodSeconds: 3
      volumes:
        - name: script
          configMap:
            name: mock-psp-script
---
apiVersion: v1
kind: Service
metadata:
  name: mock-psp
  namespace: payments
  labels:
    app: mock-psp
spec:
  selector:
    app: mock-psp
  ports:
    - port: 4000
      targetPort: 4000
```

## 2. Allow `omniswitch-api` to reach it

`k8s/network-policy.yaml`'s `default-deny-all` blocks this by default —
add a test-only pair of rules (never merge these into the tracked file;
there is no `mock-psp` in a real deployment for them to apply to):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: test-only-allow-api-to-mock-psp
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: omniswitch-api
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: mock-psp
      ports:
        - protocol: TCP
          port: 4000
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: test-only-allow-ingress-to-mock-psp
  namespace: payments
spec:
  podSelector:
    matchLabels:
      app: mock-psp
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: omniswitch-api
      ports:
        - protocol: TCP
          port: 4000
```

## 3. Point the app at `mock-psp` instead of the real endpoints

Don't edit `k8s/configmap.yaml` — patch the live ConfigMap and restart
the app's pods to pick it up, so reverting is a straightforward re-apply
of the real tracked file:

```
kubectl patch configmap omniswitch-config -n payments --type merge -p '
data:
  STRIPE_BASE_URL: "http://mock-psp.payments.svc.cluster.local:4000/v1"
  ADYEN_BASE_URL: "http://mock-psp.payments.svc.cluster.local:4000/adyen"
  FX_RATE_PROVIDER_URL: "http://mock-psp.payments.svc.cluster.local:4000/fx"
  KYC_PROVIDER_URL: "http://mock-psp.payments.svc.cluster.local:4000/kyc"
  BANK_TRANSFER_PROVIDER_URL: "http://mock-psp.payments.svc.cluster.local:4000/bank"
'
kubectl rollout restart deployment/omniswitch-api -n payments
```

(`ADYEN_MERCHANT_ACCOUNT` can stay as-is — the mock server doesn't
validate it.)

## 4. Run a real charge, measure what's needed

With the above in place, `POST /payments/charge` against the real
`omniswitch-api` Service completes a full round trip: HMAC verification
→ Vault decrypt → PgBouncer/Postgres → the Stripe or Adyen adapter →
`mock-psp` → ledger write. `scripts/load-test/artillery-config.yml` (with
`scripts/load-test/processor.js`'s HMAC-signing hooks) is the existing,
tracked tool for driving this — point it at the cluster's exposed
`omniswitch-api` Service the same way any other load-testing pass
against this app does.

## 5. Clean up

```
kubectl delete deployment,service mock-psp -n payments
kubectl delete configmap mock-psp-script -n payments
kubectl delete networkpolicy test-only-allow-api-to-mock-psp test-only-allow-ingress-to-mock-psp -n payments
kubectl apply -f k8s/configmap.yaml
kubectl rollout restart deployment/omniswitch-api -n payments
```

The last two steps matter — `kubectl apply -f k8s/configmap.yaml` alone
restores the ConfigMap's data, but pods that already read the patched
values keep them in memory (`ConfigMap` env values aren't hot-reloaded)
until restarted.
