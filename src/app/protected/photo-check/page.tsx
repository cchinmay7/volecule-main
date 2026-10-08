import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckForm } from './check-form'

export default function PhotoCheckPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Photo storage check</CardTitle>
        <p className="text-muted-foreground text-sm">
          Confirms that photos from the Google Forms can be stored and shown. It
          uploads a one-pixel test image the same way the form script does,
          checks it arrived, reads it back, and deletes it. Nothing is added to
          any log. Run it after deploying, or whenever photos stop appearing.
        </p>
      </CardHeader>
      <CardContent>
        <CheckForm />
      </CardContent>
    </Card>
  )
}
