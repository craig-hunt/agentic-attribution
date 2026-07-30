package ingest

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Options struct {
	SeedDir            string
	MappingPath        string
	EmbeddingPipeline  string
	SearchPipelinePath string
	IndexVersion       string
	SkipModel          bool
	DropRetired        bool
	Out                io.Writer
}

type Result struct {
	Timings       []PhaseTiming
	IndexName     string
	DocumentCount int64
	RetiredIndex  []string
	Total         time.Duration
}

type Pipeline struct {
	pg     *PostgresLoader
	docs   *DocumentSource
	search *OpenSearchClient
	out    io.Writer
}

func NewPipeline(pool *pgxpool.Pool, search *OpenSearchClient, out io.Writer) *Pipeline {
	if out == nil {
		out = io.Discard
	}

	return &Pipeline{
		pg:     NewPostgresLoader(pool),
		docs:   NewDocumentSource(pool),
		search: search,
		out:    out,
	}
}

// Run executes the full ingest: Postgres load with partition swap, then an
// OpenSearch index rebuild with alias swap. Neither serving path observes a
// partial state at any point.
func (p *Pipeline) Run(ctx context.Context, opts Options) (Result, error) {
	overall := time.Now()
	result := Result{IndexName: "products_v" + opts.IndexVersion}

	p.logf("waiting for opensearch\n")
	if err := p.search.WaitForCluster(ctx, 3*time.Minute); err != nil {
		return result, err
	}

	// Postgres first. The OpenSearch rebuild reads from it, so a failed
	// Postgres load must abort before any index work begins.
	p.logf("\npostgres: reference tables\n")
	refTimings, err := p.pg.LoadReference(ctx, opts.SeedDir)
	if err != nil {
		return result, err
	}
	result.Timings = append(result.Timings, refTimings...)
	p.reportTimings(refTimings)

	p.logf("\npostgres: listings (stage, validate, rebuild, swap)\n")
	listingTimings, err := p.pg.LoadListings(ctx, opts.SeedDir)
	if err != nil {
		return result, err
	}
	result.Timings = append(result.Timings, listingTimings...)
	p.reportTimings(listingTimings)

	// Model registration downloads a Hugging Face artifact on first run and
	// costs minutes. Subsequent runs reuse the deployed model.
	modelID := ""
	if !opts.SkipModel {
		p.logf("\nopensearch: registering embedding model (first run downloads the artifact)\n")
		start := time.Now()

		if err := p.search.EnableLocalModels(ctx); err != nil {
			return result, fmt.Errorf("enable local models: %w", err)
		}

		modelID, err = p.search.RegisterEmbeddingModel(ctx)
		if err != nil {
			return result, err
		}

		timing := PhaseTiming{Phase: "register_model", Rows: 1, Duration: time.Since(start)}
		result.Timings = append(result.Timings, timing)
		p.reportTimings([]PhaseTiming{timing})
		p.logf("  model_id %s\n", modelID)
	}

	if modelID != "" {
		template, err := os.ReadFile(opts.EmbeddingPipeline)
		if err != nil {
			return result, fmt.Errorf("read embedding pipeline: %w", err)
		}
		if err := p.search.CreateEmbeddingPipeline(ctx, modelID, string(template)); err != nil {
			return result, err
		}
	}

	searchPipeline, err := os.ReadFile(opts.SearchPipelinePath)
	if err != nil {
		return result, fmt.Errorf("read search pipeline: %w", err)
	}
	if err := p.search.CreateSearchPipeline(ctx, string(searchPipeline)); err != nil {
		return result, err
	}

	mapping, err := os.ReadFile(opts.MappingPath)
	if err != nil {
		return result, fmt.Errorf("read mapping: %w", err)
	}
	if err := p.search.CreateVersionedIndex(ctx, result.IndexName, string(mapping)); err != nil {
		return result, err
	}
	p.logf("\nopensearch: created %s (refresh -1, replicas 0, async translog)\n", result.IndexName)

	// Bulk index. The four tuning settings are already applied by the mapping,
	// so throughput here reflects them.
	start := time.Now()
	indexed, err := p.docs.Stream(ctx, BulkBatchSize, func(batch []ProductDocument) error {
		return p.search.BulkIndex(ctx, result.IndexName, batch)
	})
	if err != nil {
		return result, fmt.Errorf("bulk index: %w", err)
	}

	bulkTiming := PhaseTiming{Phase: "bulk_index", Rows: indexed, Duration: time.Since(start)}
	result.Timings = append(result.Timings, bulkTiming)
	p.reportTimings([]PhaseTiming{bulkTiming})

	// Validate against a count derived from Postgres rather than trusting the
	// bulk responses. A silently dropped batch is the failure this catches.
	expected, err := p.docs.CountProducts(ctx)
	if err != nil {
		return result, fmt.Errorf("count expected products: %w", err)
	}

	p.logf("\nopensearch: finalizing (restore replicas, refresh, force merge)\n")
	start = time.Now()
	if err := p.search.FinalizeIndex(ctx, result.IndexName); err != nil {
		return result, err
	}
	finalizeTiming := PhaseTiming{Phase: "finalize_index", Rows: indexed, Duration: time.Since(start)}
	result.Timings = append(result.Timings, finalizeTiming)
	p.reportTimings([]PhaseTiming{finalizeTiming})

	actual, err := p.search.CountDocuments(ctx, result.IndexName)
	if err != nil {
		return result, fmt.Errorf("count indexed documents: %w", err)
	}
	if actual != expected {
		return result, fmt.Errorf("index holds %d documents, postgres expects %d; refusing to swap the alias",
			actual, expected)
	}
	result.DocumentCount = actual
	p.logf("  validated %d documents against postgres\n", actual)

	// Only now does serving traffic move. Everything before this point was
	// invisible to readers.
	start = time.Now()
	retired, err := p.search.SwapAlias(ctx, result.IndexName)
	if err != nil {
		return result, err
	}
	result.RetiredIndex = retired

	swapTiming := PhaseTiming{Phase: "swap_alias", Rows: actual, Duration: time.Since(start)}
	result.Timings = append(result.Timings, swapTiming)
	p.logf("\nopensearch: alias %s now resolves to %s\n", ProductsAlias, result.IndexName)
	p.reportTimings([]PhaseTiming{swapTiming})

	if opts.DropRetired {
		for _, old := range retired {
			if err := p.search.DeleteIndex(ctx, old); err != nil {
				return result, fmt.Errorf("delete retired index %s: %w", old, err)
			}
			p.logf("  dropped retired index %s\n", old)
		}
		if err := p.pg.DropRetiredPartitions(ctx); err != nil {
			return result, err
		}
		p.logf("  dropped retired postgres partitions\n")
	} else if len(retired) > 0 {
		p.logf("  retained %v for rollback; rerun with -drop-retired to remove\n", retired)
	}

	result.Total = time.Since(overall)

	return result, nil
}

func (p *Pipeline) logf(format string, args ...any) {
	fmt.Fprintf(p.out, format, args...)
}

func (p *Pipeline) reportTimings(timings []PhaseTiming) {
	for _, t := range timings {
		if t.Rows > 1 {
			p.logf("  %-18s %10s  %12.0f rows/sec\n",
				t.Phase, t.Duration.Round(time.Millisecond), t.RowsPerSecond())
			continue
		}
		p.logf("  %-18s %10s\n", t.Phase, t.Duration.Round(time.Millisecond))
	}
}
