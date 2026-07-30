import pg from 'pg';

export interface Listing {
  listingId: string;
  productId: string;
  listingTitle: string;
  priceCents: number;
  currency: string;
  inStock: boolean;
}

// The merchant reads the listings table because those rows are its own feed
// data, ingested from it rather than owned by the platform. A real merchant
// would read the same records out of its own commerce backend. The simulation
// stops short of standing up a second database to hold a copy of what the
// merchant already published. See ADR-0005.
export class Catalog {
  readonly #pool: pg.Pool;
  readonly #merchantId: string;

  constructor(dsn: string, merchantId: string) {
    // Small pool on purpose. This process serves one merchant's traffic and
    // holds no connection across the settlement round trip.
    this.#pool = new pg.Pool({ connectionString: dsn, max: 4 });
    this.#merchantId = merchantId;
  }

  async findListing(productId: string): Promise<Listing | null> {
    const result = await this.#pool.query<{
      listing_id: string;
      product_id: string;
      listing_title: string;
      price_cents: string;
      currency: string;
      in_stock: boolean;
    }>(
      `SELECT listing_id, product_id, listing_title, price_cents, currency, in_stock
         FROM listings
        WHERE product_id = $1 AND merchant_id = $2`,
      [productId, this.#merchantId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      listingId: row.listing_id,
      productId: row.product_id,
      listingTitle: row.listing_title,
      // BIGINT arrives as a string from node-postgres because it can exceed
      // Number.MAX_SAFE_INTEGER. Prices in cents never approach that, so the
      // conversion is safe here and would not be for an aggregate.
      priceCents: Number(row.price_cents),
      currency: row.currency,
      inStock: row.in_stock,
    };
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
